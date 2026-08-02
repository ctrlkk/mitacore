import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

// esbuild 无法静态分析的运行时 require 链，必须外置后由 bun install 装入 dist
// 共享给 build.ts（esbuild external）和 scripts/build.ts（生成最小 package.json）
export const requirePkgs = [
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
];

// 用标准 ES + Node URL API 拿本子包目录（替代 Bun 特有的 import.meta.dir）
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

// 输出路径可通过命令行覆盖，默认到本子包 dist
const outfile = process.argv[2] ?? join(packageDir, "dist", "playwright.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(packageDir, "main.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  banner: { js: `const __import_meta_url = require("url").pathToFileURL(__filename).href;` },
  define: { "import.meta.url": "__import_meta_url" },
  external: ["*.node", ...requirePkgs],
  minify: true,
  outfile,
  logLevel: "info",
});
