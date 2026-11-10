import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { deletePidFile, readPidFile } from "../pid-file.ts";
import { spawnSupervised, type PlatformAdapter } from "./platform.ts";

/** 检查 Windows 进程是否存活。 */
function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    const out = execSync(`tasklist /NH /FI "PID eq ${pid}" /FO CSV`, {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return !out.includes("INFO:") && out.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

export function forceKillWindowsProcess(pid: number): void {
  if (!pid) return;
  try {
    execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
  } catch {}
}

export const windowsAdapter: PlatformAdapter = {
  findQQ() {
    try {
      const out = execSync('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT" /v Install', {
        encoding: "utf-8",
        timeout: 5000,
      });
      const match = out.match(/Install\s+REG_\w+\s+(.+)/);
      return match ? match[1]!.trim() : null;
    } catch {
      return null;
    }
  },

  async cleanOrphans(runtimeDir: string, qqId: string): Promise<void> {
    const record = readPidFile(runtimeDir, qqId);
    if (!record) return;
    if (!isPidAlive(record.launcher)) deletePidFile(runtimeDir, qqId);
  },

  async spawn(args) {
    const { qqId, napcatDir, qqExe, mjsPath, qqntPath, runtimeDir, supervisorPaths, logger } = args;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: qqntPath,
      NAPCAT_LOAD_PATH: resolve(napcatDir, "loadNapCat.js"),
      NAPCAT_INJECT_PATH: resolve(napcatDir, "NapCatWinBootHook.dll"),
      NAPCAT_LAUNCHER_PATH: resolve(napcatDir, "NapCatWinBootMain.exe"),
      NAPCAT_MAIN_PATH: mjsPath,
    };

    const launcher = resolve(napcatDir, "NapCatWinBootMain.exe");
    const spawnArgs = [resolve(dirname(qqExe), "QQ.exe"), resolve(napcatDir, "NapCatWinBootHook.dll"), qqId];
    logger.info({ launcher, args: spawnArgs }, "启动 NapCat launcher (win32)");
    const proc = await spawnSupervised(runtimeDir, supervisorPaths, logger, qqId, launcher, spawnArgs, env);
    return { proc, qqPid: 0, webuiPort: 0, webuiToken: "" };
  },
};
