import {
  existsSync,
  rmSync,
  mkdirSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { requirePkgs } from "../packages/playwright/externals.ts";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist");

const exeExt = process.platform === "win32" ? ".exe" : "";

// 清理路径（删除目录或文件）
function clean(p: string) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

/**
 * 构建应用主程序：Bun 编译为单文件可执行程序
 */
async function buildApp() {
  const bunBin = `app${exeExt}`;

  // 从 package.json 读 main 入口
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const bunEntry = join(root, pkg.module ?? "src/index.ts");

  clean(join(outDir, bunBin));

  const bunArgs = ["bun", "build", "--compile", "--outfile", join(outDir, bunBin), bunEntry];
  const proc = Bun.spawn({
    cmd: bunArgs,
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Bun 失败，退出码 ${code}`);

  // 清理中间产物
  clean(join(root, "build"));
  clean(join(root, "pyrpc.spec"));
}

/**
 * 构建 Node sidecar：调用 packages/playwright 自管的 esbuild 打包，
 * 然后复制产物 + 写最小 package.json + 安装运行时依赖
 */
async function buildSidecar() {
  const sidecarDir = join(outDir, "sidecar");
  const pkgDir = join(root, "packages", "playwright");
  const bundleOut = join(sidecarDir, "playwright.cjs");

  clean(join(sidecarDir, "node_modules"));
  mkdirSync(sidecarDir, { recursive: true });

  // 子包自管打包：产物输出到 packages/playwright/dist/playwright.cjs
  const buildProc = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: pkgDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const buildCode = await buildProc.exited;
  if (buildCode !== 0) throw new Error(`子包 build 失败，退出码 ${buildCode}`);

  const bundleSrc = join(pkgDir, "dist", "playwright.cjs");
  if (!existsSync(bundleSrc)) throw new Error(`找不到子包 build 产物：${bundleSrc}`);
  copyFileSync(bundleSrc, bundleOut);

  // 生成最小 package.json：只包含 esbuild externalize 的直接依赖
  // 它们的传递依赖（clone-deep / lazy-cache / kind-of / chromium-bidi / ...）bun install 自动解析
  const sidecarPkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
    type?: string;
    dependencies?: Record<string, string>;
  };
  const runtimeDeps: Record<string, string> = {};
  for (const name of [...requirePkgs, "playwright"]) {
    const ver = sidecarPkg.dependencies?.[name];
    if (ver) runtimeDeps[name] = ver;
  }
  writeFileSync(
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
  const installCmd = ["bun", "install", "--linker=hoisted", "--omit=dev", "--omit=peer"];
  const installProc = Bun.spawn({
    cmd: installCmd,
    cwd: sidecarDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const installCode = await installProc.exited;
  if (installCode !== 0) throw new Error(`Install 失败，退出码 ${installCode}`);
}

async function copyBin() {
  const outBinDir = join(outDir, "bin");

  // 复制 Node 运行时到输出目录
  const nodeBin = Bun.which("node");
  if (!nodeBin) {
    console.warn("找不到系统 node，跳过复制。请确保目标环境有 node。");
    return;
  }
  mkdirSync(outBinDir, { recursive: true });
  const targetNodePath = join(outBinDir, `node${exeExt}`);
  console.log(`复制 ${nodeBin} → ${targetNodePath}`);
  copyFileSync(nodeBin, targetNodePath);
  // 非 Windows 环境补充执行权限 (rwxr-xr-x)
  if (process.platform !== "win32") {
    chmodSync(targetNodePath, 0o755);
  }

  // 复制 ffmpeg 到输出目录（用于 GIF 压缩）
  const ffmpegBin = Bun.which("ffmpeg");
  if (ffmpegBin) {
    const targetFfmpegPath = join(outBinDir, `ffmpeg${exeExt}`);
    console.log(`复制 ${ffmpegBin} → ${targetFfmpegPath}`);
    copyFileSync(ffmpegBin, targetFfmpegPath);
    if (process.platform !== "win32") {
      chmodSync(targetFfmpegPath, 0o755);
    }
  } else {
    console.warn("找不到系统 ffmpeg，跳过复制。请确保目标环境有 ffmpeg。");
  }
}

// 准备输出目录
mkdirSync(outDir, { recursive: true });

// 并行构建
await Promise.all([buildApp(), buildSidecar(), copyBin()]);

console.log("\n==> 构建完成：");
for (const f of readdirSync(outDir)) {
  const p = join(outDir, f);
  if (!statSync(p).isFile()) continue;
  const mb = (statSync(p).size / 1024 / 1024).toFixed(2);
  console.log(` ${f.padEnd(15)} ${mb} MB`);
}