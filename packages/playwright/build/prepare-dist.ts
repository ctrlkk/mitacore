import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeExternalPackages } from "./runtime-dependencies.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageDir, "dist");
const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
};
const dependencies = Object.fromEntries(
  [...runtimeExternalPackages, "playwright"].flatMap((name) => {
    const version = packageJson.dependencies?.[name];
    return version ? [[name, version]] : [];
  }),
);

await mkdir(distDir, { recursive: true });
await writeFile(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: "playwright-sidecar",
      private: true,
      type: "module",
      dependencies,
    },
    null,
    2,
  ),
);

const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(
  packageManager,
  ["install", "--ignore-workspace", "--prod", "--node-linker=hoisted", "--config.confirmModulesPurge=false"],
  {
    cwd: distDir,
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);
const exitCode = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (exitCode !== 0) throw new Error(`安装 sidecar 外置依赖失败（退出码: ${exitCode ?? "未知"}）`);
