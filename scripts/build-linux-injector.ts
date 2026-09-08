import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("当前平台不是 Linux，跳过 NapCat Linux 注入器构建");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "napcat-linux-launcher", "launcher.cpp");
const outputDir = join(root, "native", "napcat-linux-launcher", "target", "release");
const output = join(outputDir, "libnapcat_launcher.so");
const compiler = process.env.CXX || "g++";

await mkdir(outputDir, { recursive: true });

const args = [
  "-std=c++17",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fno-exceptions",
  "-fno-rtti",
  "-fPIC",
  "-shared",
  source,
  "-o",
  output,
  "-ldl",
];
const code = await new Promise<number>((resolve, reject) => {
  const child = spawn(compiler, args, { cwd: root, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
});

if (code !== 0) throw new Error(`NapCat Linux 注入器构建失败 (退出码: ${code})`);
console.log(`NapCat Linux 注入器已构建: ${output}`);
