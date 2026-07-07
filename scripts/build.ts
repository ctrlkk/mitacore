import { spawn } from "bun";
import { build as esbuild } from "esbuild";
import { existsSync, rmSync, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pythonDir = join(root, "python"); // 暂未启用：python/ 目录已删除，函数悬空待复用
const outDir = join(root, "dist");
const sidecarDir = join(outDir, "sidecar"); // sidecar 自包含子目录：sidecar.cjs + node_modules
const exeExt = process.platform === "win32" ? ".exe" : "";
const pyBin = `pyrpc${exeExt}`;
const bunBin = `app${exeExt}`;
const venvPython = process.platform === "win32"
  ? join(pythonDir, ".venv", "Scripts", "python.exe")
  : join(pythonDir, ".venv", "bin", "python");

// 从 package.json 读 main 入口
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { module?: string };
const bunEntry = join(root, pkg.module ?? "src/index.ts");

async function run(name: string, cmd: string[], cwd = root, env?: Record<string, string>): Promise<number> {
  console.log(`[${name}] ${cmd.join(" ")}`);
  const proc = spawn({ cmd, cwd, stdio: ["ignore", "inherit", "inherit"], env: env ? { ...process.env, ...env } : undefined });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${name} 失败，退出码 ${code}`);
  return Date.now();
}

function clean(p: string) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

async function buildPython(t0: number): Promise<number> {
  // 暂未启用：python/ 目录已删除。要恢复时把 python/ 还原 + 在下面 buildApp 里 await 即可。
  const pyArgs = [
    venvPython, "-m", "PyInstaller",
    "--onedir", "--noconfirm", "--name", "pyrpc",
    "--distpath", outDir,
    "--workpath", join(root, "build"),
    "--specpath", root,
    "--collect-submodules", "handlers",
    "--collect-all", "playwright",
    "--collect-all", "playwright_stealth",
    "--collect-all", "greenlet",
    "--collect-binaries", "playwright",
    "--collect-data", "playwright",
    "--collect-submodules", "playwright._impl",
    "--hidden-import", "greenlet",
    "--copy-metadata", "playwright",
    "--copy-metadata", "playwright_stealth",
    "--log-level", "WARN",
    "main.py",
  ];
  const pyEnv = { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
  return (await run("Python", pyArgs, pythonDir, pyEnv)) - t0;
}

async function buildApp(t0: number): Promise<number> {
  const bunArgs = ["bun", "build", "--compile", "--outfile", join(outDir, bunBin), bunEntry];
  return (await run("Bun", bunArgs)) - t0;
}

// SEA embedderRequire 不支持的老式 CJS monkey-patch 包（puppeteer-extra 工具链）
// externalize 让 Node 原生 require 处理；bundler 静态分析也无法还原 `require = utils` 模式
const DYNAMIC_REQUIRE_PKGS = new Set([
  "puppeteer-extra-plugin-stealth",
  "puppeteer-extra",
  "clone-deep",
  "lazy-cache",
  "kind-of",
  "is-plain-object",
  "shallow-clone",
  "for-in",
  "for-own",
  "mixin-deep",
]);

async function buildSidecar(t0: number): Promise<number> {
  // 用 esbuild JS API 而不是 CLI：避免 bun spawn 在 Windows 下数组参数合并的问题
  // 打包策略：
  //   - esbuild 把 main.ts + 静态可分析的依赖打成单个 CJS
  //   - external: *.node（原生模块）+ 上面的老 CJS monkey-patch 包
  //   - import.meta.url 用 banner 注入 polyfill（CJS 输出没有 import.meta，必须显式构造）
  mkdirSync(sidecarDir, { recursive: true });
  console.log("[Sidecar] esbuild bundling → sidecar.cjs");
  const result = await esbuild({
    entryPoints: [join(root, "node-sidecar", "main.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    banner: { js: `const __import_meta_url = require("url").pathToFileURL(__filename).href;` },
    define: { "import.meta.url": "__import_meta_url" },
    external: ["*.node", ...DYNAMIC_REQUIRE_PKGS],
    outfile: join(sidecarDir, "sidecar.cjs"),
    logLevel: "info",
  });
  if (result.errors.length) throw new Error(`Sidecar esbuild 失败：${result.errors.map((e) => e.text).join("\n")}`);
  return Date.now() - t0;
}

// 在 dist/sidecar/ 里用 bun install --linker=hoisted 装一份标准 npm 布局的 node_modules
// --omit=dev/--omit=peer 跳过无关依赖；最小化 package.json 只放真正 external 的包（playwright 套件 +
// puppeteer-extra 套件），bundler 把 elysia/p-queue/etc. 内联了，就不该出现在 node_modules 里
async function pruneSidecarDeps(t0: number): Promise<number> {
  // 清理 dist/sidecar/ 之前的 node_modules（保留 sidecar.cjs）
  const oldNm = join(sidecarDir, "node_modules");
  if (existsSync(oldNm)) rmSync(oldNm, { recursive: true, force: true });

  // 生成最小 package.json：只包含 esbuild externalize 的直接依赖
  // 它们的传递依赖（clone-deep / lazy-cache / kind-of / chromium-bidi / ...）bun install 自动解析
  const sidecarPkg = JSON.parse(readFileSync(join(root, "node-sidecar", "package.json"), "utf-8")) as {
    type?: string;
    dependencies?: Record<string, string>;
  };
  const runtimeDeps: Record<string, string> = {};
  for (const name of [...DYNAMIC_REQUIRE_PKGS, "playwright"]) {
    const ver = sidecarPkg.dependencies?.[name];
    if (ver) runtimeDeps[name] = ver;
  }
  writeFileSync(
    join(sidecarDir, "package.json"),
    JSON.stringify({ name: "sidecar-runtime", private: true, type: sidecarPkg.type ?? "commonjs", dependencies: runtimeDeps }, null, 2),
  );

  return (await run(
    "Prune",
    ["bun", "install", "--linker=hoisted", "--omit=dev", "--omit=peer"],
    sidecarDir,
  )) - t0;
}

// 准备
mkdirSync(outDir, { recursive: true });
clean(join(outDir, pyBin));
clean(join(outDir, bunBin));
clean(join(root, "build"));
clean(join(pythonDir, "build"));
clean(join(root, "pyrpc.spec"));
clean(join(pythonDir, "pyrpc.spec"));

// 1. uv sync 必须先跑（pyinstaller 依赖 venv 里的 pyinstaller）
//    暂未启用：python/ 不存在；恢复时取消下面这行注释
// await run("uv sync", ["uv", "sync", "--group", "dev"], pythonDir);

// 2. Python 与 Bun 并行编译（互不依赖，输出文件名不同）
//    暂未启用：只跑 Bun；要同时跑 Python 时把 Promise.allSettled 里的两个分支都启用
const t0 = Date.now();
const [bunMs, sidecarMs] = await Promise.all([buildApp(t0), buildSidecar(t0)]);
const pruneMs = await pruneSidecarDeps(t0);
console.log(`==> 总耗时 ${Date.now() - t0}ms（bun=${bunMs}ms, sidecar=${sidecarMs}ms, prune=${pruneMs}ms）`);

// 清理中间产物
clean(join(root, "build"));
clean(join(pythonDir, "build"));
clean(join(root, "pyrpc.spec"));
clean(join(pythonDir, "pyrpc.spec"));

console.log("\n==> 构建完成：");
for (const f of readdirSync(outDir)) {
  const p = join(outDir, f);
  if (!statSync(p).isFile()) continue;
  const mb = (statSync(p).size / 1024 / 1024).toFixed(2);
  console.log(`  ${f.padEnd(15)} ${mb} MB`);
}