import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requirePkgs } from "./externals.ts";
import esbuild from "esbuild";

// 用标准 ES + Node URL API 拿当前文件目录（替代 Bun 特有的 import.meta.dir）
const selfDir = dirname(fileURLToPath(import.meta.url));

// 输出路径可通过命令行覆盖，默认到本子包 dist
const outfile = process.argv[2] ?? join(selfDir, "dist", "playwright.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(selfDir, "main.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  banner: { js: `const __import_meta_url = require("url").pathToFileURL(__filename).href;` },
  define: { "import.meta.url": "__import_meta_url" },
  external: ["*.node", ...requirePkgs],
  outfile,
  logLevel: "info",
});
