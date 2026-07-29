import { join } from "node:path";
import { requirePkgs } from "../packages/playwright/scripts/build";
import { rm, mkdir, copyFile, readFile, writeFile, access, stat, chmod, readdir, cp } from "node:fs/promises";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist");

const exeExt = process.platform === "win32" ? ".exe" : "";

/**
 * 执行子进程，如果退出码非 0 则抛出异常
 */
async function runCmd(cmd: string[], cwd: string) {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`命令执行失败: ${cmd.join(" ")} (退出码: ${code})`);
}

/**
 * 构建应用主程序：Bun 编译为单文件可执行程序
 */
async function buildApp() {
  const bunBin = `app${exeExt}`;
  const botDir = join(root, "packages", "bot");

  // 从 package.json 读 main 入口
  const pkgRaw = await readFile(join(botDir, "package.json"), "utf-8");
  const pkg = JSON.parse(pkgRaw);
  const bunEntry = join(botDir, pkg.module ?? "src/index.ts");

  // 清理旧产物 (force: true 确保路径不存在时不报错，省去 existsSync 判断)
  await rm(join(outDir, bunBin), { force: true });
  await rm(join(root, "build"), { recursive: true, force: true });
  await rm(join(root, "pyrpc.spec"), { force: true });

  // 执行 Bun 编译
  await runCmd(
    ["bun", "build", "--compile", "--define", "__STANDALONE__=true", "--outfile", join(outDir, bunBin), bunEntry],
    root,
  );
}

/** 构建 WebUI 并复制到应用同目录，供 Hono 在生产环境托管。 */
async function buildWebUi() {
  const webUiDir = join(root, "packages", "webui");
  const outputDir = join(outDir, "webui");
  await runCmd(["bun", "run", "build"], webUiDir);
  await rm(outputDir, { recursive: true, force: true });
  await cp(join(webUiDir, "dist"), outputDir, { recursive: true });
}

/**
 * 构建 Node sidecar：调用 packages/playwright 自管的 esbuild 打包，
 * 然后复制产物 + 写最小 package.json + 安装运行时依赖
 */
async function buildSidecar() {
  const sidecarDir = join(outDir, "sidecar");
  const pkgDir = join(root, "packages", "playwright");
  const bundleOut = join(sidecarDir, "playwright.cjs");

  // 清理旧依赖并创建目录
  await rm(join(sidecarDir, "node_modules"), { recursive: true, force: true });
  await mkdir(sidecarDir, { recursive: true });

  // 子包自管打包
  await runCmd(["bun", "run", "build"], pkgDir);

  // 复制产物
  const bundleSrc = join(pkgDir, "dist", "playwright.cjs");
  try {
    await access(bundleSrc);
  } catch {
    throw new Error(`找不到子包 build 产物：${bundleSrc}`);
  }
  await copyFile(bundleSrc, bundleOut);

  // 生成最小 package.json
  const pkgRaw = await readFile(join(pkgDir, "package.json"), "utf-8");
  const sidecarPkg = JSON.parse(pkgRaw) as {
    type?: string;
    dependencies?: Record<string, string>;
  };

  const runtimeDeps: Record<string, string> = {};
  for (const name of [...requirePkgs, "playwright"]) {
    const ver = sidecarPkg.dependencies?.[name];
    if (ver) runtimeDeps[name] = ver;
  }

  await writeFile(
    join(sidecarDir, "package.json"),
    JSON.stringify(
      {
        name: "sidecar-runtime",
        private: true,
        type: sidecarPkg.type ?? "commonjs",
        dependencies: runtimeDeps,
      },
      null,
      2,
    ),
  );

  // 安装运行时依赖
  await runCmd(["bun", "install", "--linker=hoisted", "--omit=dev", "--omit=peer"], sidecarDir);
}

/**
 * 复制所需的外部二进制文件到输出目录的 bin 子目录
 */
async function copyBin() {
  const outBinDir = join(outDir, "bin");
  const bins = ["node", "ffmpeg", "ffprobe", "gifsicle"];

  await mkdir(outBinDir, { recursive: true });

  for (const name of bins) {
    const srcPath = Bun.which(name);
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
 * 复制运行时资源：prompts 目录、config.example.toml、config.toml
 */
async function copyAssets() {
  const targets: Array<{ src: string; dest: string; label: string }> = [
    { src: join(root, "prompts"), dest: join(outDir, "prompts"), label: "prompts/" },
    { src: join(root, "config.example.toml"), dest: join(outDir, "config.example.toml"), label: "config.example.toml" },
    { src: join(root, "config.example.toml"), dest: join(outDir, "config.toml"), label: "config.toml" },
  ];

  for (const { src, dest, label } of targets) {
    try {
      const stats = await stat(src);
      // 确保目标父目录存在
      await mkdir(join(dest, ".."), { recursive: true });
      // node:fs/promises 的 cp 方法原生支持递归目录拷贝和文件拷贝，无需分类讨论
      await cp(src, dest, { recursive: stats.isDirectory() });
      console.log(`复制 ${label} → ${dest}`);
    } catch {
      console.warn(`跳过：${label}（源不存在 ${src}）`);
    }
  }
}

console.log("==> 开始并行构建...\n");
await mkdir(outDir, { recursive: true });

await Promise.all([buildApp(), buildWebUi(), buildSidecar(), copyBin(), copyAssets()]);

console.log("\n==> 构建完成：");
const files = await readdir(outDir);
for (const f of files) {
  const p = join(outDir, f);
  const stats = await stat(p);
  if (!stats.isFile()) continue;
  const mb = (stats.size / 1024 / 1024).toFixed(2);
  console.log(` ${f.padEnd(15)} ${mb} MB`);
}
