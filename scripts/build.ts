import { delimiter, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { rm, mkdir, copyFile, access, stat, chmod, readdir, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as typeof import("@ffmpeg-installer/ffmpeg");
const { path: ffprobePath } = require("@ffprobe-installer/ffprobe") as typeof import("@ffprobe-installer/ffprobe");
const { default: gifsiclePath } = await import("gifsicle");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");

const exeExt = process.platform === "win32" ? ".exe" : "";

/** 仅清理由本脚本管理的顶层产物，避免影响运行时数据。 */
async function cleanBuildOutputs() {
  // 旧版 prompts/role.txt 是用户数据，保留 prompts/ 供启动迁移及版本回退使用。
  const outputNames = [
    "bin",
    "references",
    "scripts",
    "webui",
    ".env.example",
    "app",
    "app.exe",
    "app.mjs",
    "config.example.jsonc",
    "config.schema.json",
    "main.mjs",
  ];
  await Promise.all(outputNames.map((name) => rm(join(outDir, name), { recursive: true, force: true })));
}

/**
 * 执行子进程，如果退出码非 0 则抛出异常
 */
async function runCmd(cmd: string[], cwd: string) {
  const [executable, ...args] = cmd;
  if (!executable) throw new Error("命令不能为空");

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      shell: process.platform === "win32" && executable.endsWith(".cmd"),
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`命令执行失败: ${cmd.join(" ")} (退出码: ${code})`);
}

const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function findExecutable(name: string) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates =
    process.platform === "win32"
      ? [name, ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => `${name}${ext.toLowerCase()}`)]
      : [name];

  for (const pathEntry of pathEntries) {
    for (const candidate of candidates) {
      const executablePath = join(pathEntry, candidate);
      try {
        await access(executablePath, constants.X_OK);
        if ((await stat(executablePath)).isFile()) return executablePath;
      } catch {
        // 继续检查 PATH 中的下一个候选路径。
      }
    }
  }
  return undefined;
}

/**
 * 构建应用主程序
 */
async function buildApp() {
  const botDir = join(root, "packages", "bot");

  await runCmd([packageManager, "--dir", botDir, "run", "build"], root);
  await runCmd([packageManager, "run", "package:default-data", join(outDir, "references", "default-data.zip")], root);
  const manifestOutputDir = join(outDir, "references", "default-data");
  await mkdir(manifestOutputDir, { recursive: true });
  await copyFile(join(root, "references", "default-data", "manifest.json"), join(manifestOutputDir, "manifest.json"));
  await copyFile(join(root, "scripts", "main.mjs"), join(outDir, "main.mjs"));
}

/** 从运行时配置定义生成随应用发布的编辑器 Schema；失败时中止构建。 */
async function buildConfigSchema() {
  await runCmd([packageManager, "--filter", "bot", "run", "config:schema", join(outDir, "config.schema.json")], root);
}

/** 构建负责约束 NapCat 进程树生命周期的原生 supervisor。 */
async function buildSupervisor() {
  const manifest = join(root, "native", "napcat-supervisor", "Cargo.toml");
  const binaryName = `napcat-supervisor${exeExt}`;
  const outputDir = join(outDir, "bin");
  await runCmd(["cargo", "build", "--release", "--manifest-path", manifest], root);
  await mkdir(outputDir, { recursive: true });
  await copyFile(
    join(root, "native", "napcat-supervisor", "target", "release", binaryName),
    join(outputDir, binaryName),
  );
  if (process.platform !== "win32") await chmod(join(outputDir, binaryName), 0o755);
}

/** Linux 构建时生成 NapCat LD_PRELOAD 注入器并随应用发布。 */
async function buildLinuxInjector() {
  if (process.platform !== "linux") return;

  const binaryName = "libnapcat_launcher.so";
  const source = join(root, "native", "napcat-linux-launcher", "target", "release", binaryName);
  const outputDir = join(outDir, "bin");
  await runCmd([packageManager, "run", "linux-injector:build"], root);
  await mkdir(outputDir, { recursive: true });
  await copyFile(source, join(outputDir, binaryName));
}

/** 构建兼容旧版 app.exe 使用方式的 Node 启动器。 */
async function buildLauncher() {
  const manifest = join(root, "native", "app-launcher", "Cargo.toml");
  const binaryName = `app-launcher${exeExt}`;
  const outputName = `app${exeExt}`;

  await runCmd(["cargo", "build", "--release", "--manifest-path", manifest], root);
  await copyFile(join(root, "native", "app-launcher", "target", "release", binaryName), join(outDir, outputName));
  if (process.platform !== "win32") await chmod(join(outDir, outputName), 0o755);
}

/** 构建 WebUI 并复制到应用同目录，供 Hono 在生产环境托管。 */
async function buildWebUi() {
  const webUiDir = join(root, "packages", "webui");
  const outputDir = join(outDir, "webui");
  await runCmd([packageManager, "run", "build"], webUiDir);
  await cp(join(webUiDir, "dist"), outputDir, { recursive: true });
}

/**
 * 复制所需的外部二进制文件到输出目录的 bin 子目录。
 * FFmpeg 使用 npm 包提供的静态二进制，不依赖构建机器上的安装或 DLL。
 */
async function copyBin() {
  const outBinDir = join(outDir, "bin");
  const staticBins = [
    { name: "ffmpeg", sourcePath: ffmpegPath },
    { name: "ffprobe", sourcePath: ffprobePath },
    { name: "gifsicle", sourcePath: gifsiclePath },
  ];
  const systemBins = ["node"];

  await mkdir(outBinDir, { recursive: true });

  for (const { name, sourcePath } of staticBins) {
    const targetPath = join(outBinDir, `${name}${exeExt}`);
    console.log(`复制 ${sourcePath} → ${targetPath}`);
    await copyFile(sourcePath, targetPath);
    if (process.platform !== "win32") await chmod(targetPath, 0o755);
  }

  for (const name of systemBins) {
    const srcPath = await findExecutable(name);
    if (!srcPath) {
      console.warn(`找不到系统 ${name}，跳过复制。请确保目标环境有 ${name}。`);
      continue;
    }

    const targetPath = join(outBinDir, `${name}${exeExt}`);
    console.log(`复制 ${srcPath} → ${targetPath}`);

    try {
      await copyFile(srcPath, targetPath);
      // 非 Windows 环境补充执行权限
      if (process.platform !== "win32") {
        await chmod(targetPath, 0o755);
      }
    } catch (error) {
      console.warn(`复制 ${name} 失败:`, error);
    }
  }
}

/**
 * 复制运行时资源。
 */
async function copyAssets() {
  const targets = [
    { src: join(root, ".env.example"), dest: join(outDir, ".env.example"), label: ".env.example" },
    {
      src: join(root, "scripts", "install.sh"),
      dest: join(outDir, "scripts", "install.sh"),
      label: "scripts/install.sh",
      executable: true,
    },
    {
      src: join(root, "scripts", "build-linux-injector.sh"),
      dest: join(outDir, "scripts", "build-linux-injector.sh"),
      label: "scripts/build-linux-injector.sh",
      executable: true,
    },
    {
      src: join(root, "native", "napcat-linux-launcher", "launcher.c"),
      dest: join(outDir, "scripts", "launcher.c"),
      label: "scripts/launcher.c",
    },
  ];

  for (const { src, dest, label, executable } of targets) {
    try {
      const stats = await stat(src);
      // 确保目标父目录存在
      await mkdir(join(dest, ".."), { recursive: true });
      // node:fs/promises 的 cp 方法原生支持递归目录拷贝和文件拷贝，无需分类讨论
      await cp(src, dest, { recursive: stats.isDirectory() });
      if (executable && process.platform !== "win32") await chmod(dest, 0o755);
      console.log(`复制 ${label} → ${dest}`);
    } catch {
      console.warn(`跳过：${label}（源不存在 ${src}）`);
    }
  }
}

console.log("==> 开始并行构建...\n");
await mkdir(outDir, { recursive: true });
await cleanBuildOutputs();

await Promise.all([
  buildApp(),
  buildConfigSchema(),
  buildSupervisor(),
  buildLinuxInjector(),
  buildLauncher(),
  buildWebUi(),
  copyBin(),
  copyAssets(),
]);
// await runCmd([packageManager, "run", "obfuscate"], root);

console.log("\n==> 构建完成：");
const files = await readdir(outDir);
for (const f of files) {
  const p = join(outDir, f);
  const stats = await stat(p);
  if (!stats.isFile()) continue;
  const mb = (stats.size / 1024 / 1024).toFixed(2);
  console.log(` ${f.padEnd(15)} ${mb} MB`);
}
