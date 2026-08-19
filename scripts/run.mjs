import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(rootDir, ".env");

if (existsSync(configPath)) process.loadEnvFile(configPath);

const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : packageManager;
const commandArgs =
  process.platform === "win32" ? ["/d", "/s", "/c", packageManager, ...process.argv.slice(2)] : process.argv.slice(2);

const child = spawn(command, commandArgs, {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error("启动命令失败", error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
