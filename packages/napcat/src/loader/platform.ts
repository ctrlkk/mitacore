import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { napcatLockPath } from "../pid-file.ts";
import type { NapCatLogger } from "../logger.ts";

const SUPERVISOR_NAME = `napcat-supervisor${process.platform === "win32" ? ".exe" : ""}`;
const SUPERVISOR_READY = "NAPCAT_SUPERVISOR_READY";

/** 启动 NapCat 所需参数 */
export interface SpawnArgs {
  qqId: string;
  napcatDir: string;
  qqExe: string;
  mjsPath: string;
  qqntPath: string;
  runtimeDir: string;
  supervisorPaths: string[];
  linuxInjectorPaths: string[];
  logger: NapCatLogger;
}

/** NapCat 运行时内部状态 */
export interface NapcatHandle {
  proc: ChildProcess;
  qqPid: number;
  webuiPort: number;
  webuiToken: string;
}

/** 跨平台启动器接口，由 win32/linux 各自实现。 */
export interface PlatformAdapter {
  findQQ(): string | null;
  cleanOrphans(runtimeDir: string, qqId: string, qqExe: string): Promise<void>;
  spawn(args: SpawnArgs): Promise<NapcatHandle>;
}

/** 查找构建产物中的 supervisor；开发环境回退到 Cargo release 目录。 */
function resolveSupervisorPath(supervisorPaths: string[]): string {
  const path = supervisorPaths.find(existsSync);
  if (!path) {
    throw new Error(`未找到 ${SUPERVISOR_NAME}，请先构建 NapCat supervisor`);
  }
  return path;
}

/** 由 supervisor 启动目标进程，使其生命周期受 Job Object/进程组约束。 */
export function spawnSupervised(
  runtimeDir: string,
  supervisorPaths: string[],
  logger: NapCatLogger,
  qqId: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<ChildProcess> {
  const supervisor = resolveSupervisorPath(supervisorPaths);
  logger.info({ supervisor, command, args }, "通过 NapCat supervisor 启动进程");
  const proc = spawn(supervisor, ["--lock", napcatLockPath(runtimeDir, qqId), "--", command, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      proc.kill();
      reject(new Error("等待 NapCat supervisor 启动超时"));
    }, 5_000);
    timer.unref();

    const cleanup = () => {
      clearTimeout(timer);
      proc.stderr!.off("data", onData);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };
    const onData = (data: Buffer) => {
      stderr += data.toString();
      if (!stderr.includes(SUPERVISOR_READY)) return;
      cleanup();
      proc.stderr!.pause();
      resolve(proc);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(stderr.trim() || `NapCat supervisor 启动失败 (code=${code})`));
    };

    proc.stderr!.on("data", onData);
    proc.once("error", onError);
    proc.once("exit", onExit);
  });
}
