import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deletePidFile, readPidFile } from "../pid-file.ts";
import { spawnSupervised, type PlatformAdapter } from "./platform.ts";

const LINUX_INJECTOR_NAME = "libnapcat_launcher.so";

function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isExpectedExecutable(pid: number, qqExe: string): boolean {
  try {
    return realpathSync(`/proc/${pid}/exe`) === realpathSync(qqExe);
  } catch {
    return false;
  }
}

function signalQQ(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
  try {
    process.kill(pid, signal);
  } catch {}
}

async function cleanQQ(pid: number, qqExe: string): Promise<void> {
  if (!pid || !isExpectedExecutable(pid, qqExe)) return;
  signalQQ(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isPidAlive(pid) && isExpectedExecutable(pid, qqExe)) {
    signalQQ(pid, "SIGKILL");
    const forceDeadline = Date.now() + 2_000;
    while (isPidAlive(pid) && Date.now() < forceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (isPidAlive(pid) && isExpectedExecutable(pid, qqExe)) {
    throw new Error(`无法清理残留 QQ 进程 (PID=${pid})`);
  }
}

function findQQProcesses(qqExe: string, qqId: string): number[] {
  const expectedExe = realpathSync(qqExe);
  const pids: number[] = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      if (realpathSync(`/proc/${pid}/exe`) !== expectedExe) continue;
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args.some((arg, index) => arg === "-q" && args[index + 1] === qqId)) pids.push(pid);
    } catch {}
  }
  return pids;
}

function resolveInjectorPath(injectorPaths: string[]): string {
  const path = injectorPaths.find(existsSync);
  if (!path) {
    throw new Error(`未找到 ${LINUX_INJECTOR_NAME}，请在 Linux 环境重新构建应用`);
  }
  return path;
}

/** 生成 Linux 注入器使用的 package.json 补丁和真实入口脚本。 */
function prepareInjection(qqExe: string, napcatDir: string, mjsPath: string, runtimeDir: string): string {
  const qqPackagePath = resolve(dirname(realpathSync(qqExe)), "resources", "app", "package.json");
  const packageJson: unknown = JSON.parse(readFileSync(qqPackagePath, "utf8"));
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error(`QQ package.json 格式无效: ${qqPackagePath}`);
  }

  const loadPath = resolve(napcatDir, "loadNapCat.js");
  let patchedMain = relative(dirname(qqPackagePath), loadPath).replaceAll("\\", "/");
  if (!patchedMain.startsWith(".")) patchedMain = `./${patchedMain}`;
  (packageJson as Record<string, unknown>).main = patchedMain;

  const patchPath = resolve(runtimeDir, "qqnt-linux.json");
  writeFileSync(patchPath, JSON.stringify(packageJson, null, 2));
  writeFileSync(loadPath, `(async () => { await import(${JSON.stringify(pathToFileURL(mjsPath).href)}); })()`);
  return patchPath;
}

export const linuxAdapter: PlatformAdapter = {
  findQQ() {
    const candidates = ["/opt/QQ/qq", "~/opt/QQ/qq", "/usr/local/bin/qq", "/snap/bin/qq"];
    for (const path of candidates) {
      const expanded = path.startsWith("~/") ? resolve(process.env.HOME || "", path.slice(2)) : path;
      if (existsSync(expanded)) return expanded;
    }
    try {
      const out = execSync("which qq 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
      if (out.trim()) return out.trim();
    } catch {}
    return null;
  },

  async cleanOrphans(runtimeDir: string, qqId: string, qqExe: string): Promise<void> {
    const record = readPidFile(runtimeDir, qqId);
    if (record && isPidAlive(record.launcher)) return;

    const stalePids = new Set(findQQProcesses(qqExe, qqId));
    if (record?.qq) stalePids.add(record.qq);
    for (const pid of stalePids) await cleanQQ(pid, qqExe);
    if (record) deletePidFile(runtimeDir, qqId);
  },

  async spawn(args) {
    const { qqId, napcatDir, qqExe, mjsPath, runtimeDir, supervisorPaths, linuxInjectorPaths, logger } = args;
    const injector = resolveInjectorPath(linuxInjectorPaths);
    const patchPath = prepareInjection(qqExe, napcatDir, mjsPath, runtimeDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: patchPath,
      NAPCAT_DISABLE_MULTI_PROCESS: "1",
      NAPCAT_DISABLE_PIPE: "1",
    };

    const preload = process.env.LD_PRELOAD ? `${injector}:${process.env.LD_PRELOAD}` : injector;
    const injectedCommand = ["/usr/bin/env", `LD_PRELOAD=${preload}`, qqExe, "--no-sandbox", "-q", qqId];
    const useXvfb = !process.env.DISPLAY && existsSync("/usr/bin/xvfb-run");
    const command = useXvfb ? "xvfb-run" : "/usr/bin/env";
    const spawnArgs = useXvfb ? ["-a", ...injectedCommand] : injectedCommand.slice(1);
    const qqWorkingDir = resolve(runtimeDir, "qq", qqId);
    mkdirSync(qqWorkingDir, { recursive: true });
    logger.info({ cmd: command, args: spawnArgs, injector, cwd: qqWorkingDir }, "启动 NapCat launcher (linux)");
    const proc = await spawnSupervised(
      runtimeDir,
      supervisorPaths,
      logger,
      qqId,
      command,
      spawnArgs,
      env,
      qqWorkingDir,
    );
    return { proc, qqPid: 0, webuiPort: 0, webuiToken: "" };
  },
};
