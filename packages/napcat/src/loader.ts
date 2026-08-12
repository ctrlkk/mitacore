import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createNapCatApi } from "./client.ts";
import { resolve, dirname } from "node:path";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { downloadNapcat } from "./download.ts";
import { deletePidFile, napcatLockPath, readPidFile, writePidFile } from "./pid-file.ts";
import { noopLogger, type NapCatLogger } from "./logger.ts";
import oneBotConfigTemplate from "./onebot-config.json" with { type: "json" };

const LOAD_SCRIPT_FILE = "loadNapCat.js";
const SUPERVISOR_NAME = `napcat-supervisor${process.platform === "win32" ? ".exe" : ""}`;
const SUPERVISOR_READY = "NAPCAT_SUPERVISOR_READY";
const WEBUI_TOKEN_DEFAULT = Math.random().toString(36).substring(2, 15);
const IS_WIN = process.platform === "win32";

const WEBUI_URL_RE = /WebUi User Panel Url: http:\/\/127\.0\.0\.1:(\d+)\/webui\?token=(\S+)/;
const MAIN_PID_RE = /Main Process ID:(\d+)/;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, unitIndex)).toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

/** 检查进程是否存活 */
function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /NH /FI "PID eq ${pid}" /FO CSV`, {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return !out.includes("INFO:") && out.includes(`"${pid}"`);
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 强制结束进程 */
function forceKill(pid: number): void {
  if (!pid) return;
  try {
    if (IS_WIN) {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {}
}

type NapCatApi = Awaited<ReturnType<typeof createNapCatApi>>;

/** NapCat 启动配置 */
export interface NapCatConfig {
  /** QQ 账号 ID */
  qqId: string;
  /** NapCat Shell 目录路径 */
  napcatDir: string;
  /** QQNT 可执行文件路径（为空时自动查找） */
  qqPath: string;
  /** PID 与锁文件目录 */
  runtimeDir: string;
  /** supervisor 可执行文件候选路径，按顺序查找 */
  supervisorPaths: string[];
  /** 接入宿主应用的日志器 */
  logger?: NapCatLogger;
}

/** 启动 NapCat 所需参数 */
interface SpawnArgs {
  qqId: string;
  napcatDir: string;
  qqExe: string;
  mjsPath: string;
  qqntPath: string;
  runtimeDir: string;
  supervisorPaths: string[];
  logger: NapCatLogger;
}

/** NapCat 运行时内部状态 */
interface NapcatHandle {
  proc: ChildProcess;
  qqPid: number;
  webuiPort: number;
  webuiToken: string;
}

/** 跨平台启动器接口 — win32/posix 各自实现 */
interface PlatformAdapter {
  /** 查找 QQNT 可执行文件路径 */
  findQQ(): string | null;
  /** 根据 PID 文件清理上次启动残留的 supervisor 和 QQ 进程 */
  cleanOrphans(runtimeDir: string, qqId: string): Promise<void>;
  /** 启动 NapCat 进程 */
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
function spawnSupervised(
  runtimeDir: string,
  supervisorPaths: string[],
  logger: NapCatLogger,
  qqId: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const supervisor = resolveSupervisorPath(supervisorPaths);
  logger.info({ supervisor, command, args }, "通过 NapCat supervisor 启动进程");
  const proc = spawn(supervisor, ["--lock", napcatLockPath(runtimeDir, qqId), "--", command, ...args], {
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

const win32Adapter: PlatformAdapter = {
  findQQ() {
    try {
      const out = execSync('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT" /v Install', {
        encoding: "utf-8",
        timeout: 5000,
      });
      const m = out.match(/Install\s+REG_\w+\s+(.+)/);
      return m ? m[1]!.trim() : null;
    } catch {
      return null;
    }
  },

  async cleanOrphans(runtimeDir: string, qqId: string): Promise<void> {
    const rec = readPidFile(runtimeDir, qqId);
    if (!rec) return;
    if (!isPidAlive(rec.launcher)) deletePidFile(runtimeDir, qqId);
  },

  async spawn(args) {
    const { qqId, napcatDir, qqExe, mjsPath, qqntPath, runtimeDir, supervisorPaths, logger } = args;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: qqntPath,
      NAPCAT_LOAD_PATH: resolve(napcatDir, LOAD_SCRIPT_FILE),
      NAPCAT_INJECT_PATH: resolve(napcatDir, "NapCatWinBootHook.dll"),
      NAPCAT_LAUNCHER_PATH: resolve(napcatDir, "NapCatWinBootMain.exe"),
      NAPCAT_MAIN_PATH: mjsPath,
    };

    const launcher = resolve(napcatDir, "NapCatWinBootMain.exe");
    const spawnArgs = [resolve(dirname(qqExe), "QQ.exe"), resolve(napcatDir, "NapCatWinBootHook.dll"), qqId];
    logger.info({ launcher, args: spawnArgs }, "启动 NapCat launcher (win32)");
    const proc = await spawnSupervised(runtimeDir, supervisorPaths, logger, qqId, launcher, spawnArgs, env);
    const handle: NapcatHandle = {
      proc,
      qqPid: 0,
      webuiPort: 0,
      webuiToken: "",
    };
    return handle;
  },
};

const posixAdapter: PlatformAdapter = {
  findQQ() {
    const candidates = ["/opt/QQ/qq", "~/opt/QQ/qq", "/usr/local/bin/qq", "/snap/bin/qq"];
    for (const p of candidates) {
      const expanded = p.startsWith("~/") ? resolve(process.env.HOME || "", p.slice(2)) : p;
      if (existsSync(expanded)) return expanded;
    }
    try {
      const out = execSync("which qq 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
      if (out.trim()) return out.trim();
    } catch {}
    return null;
  },

  async cleanOrphans(runtimeDir: string, qqId: string): Promise<void> {
    const rec = readPidFile(runtimeDir, qqId);
    if (!rec) return;
    if (!isPidAlive(rec.launcher)) deletePidFile(runtimeDir, qqId);
  },

  async spawn(args) {
    const { qqId, qqExe, mjsPath, qqntPath, runtimeDir, supervisorPaths, logger } = args;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: qqntPath,
      NAPCAT_MAIN_PATH: mjsPath,
      NAPCAT_DISABLE_MULTI_PROCESS: "1",
      NAPCAT_DISABLE_PIPE: "1",
    };

    const useXvfb = !process.env.DISPLAY && existsSync("/usr/bin/xvfb-run");
    const cmd = useXvfb ? "xvfb-run" : qqExe;
    const spawnArgs = useXvfb ? ["-a", qqExe, "--no-sandbox", "-q", qqId] : ["--no-sandbox", "-q", qqId];
    logger.info({ cmd, args: spawnArgs }, "启动 NapCat launcher (posix)");
    const proc = await spawnSupervised(runtimeDir, supervisorPaths, logger, qqId, cmd, spawnArgs, env);
    const handle: NapcatHandle = {
      proc,
      qqPid: 0,
      webuiPort: 0,
      webuiToken: "",
    };
    return handle;
  },
};

const platform: PlatformAdapter = IS_WIN ? win32Adapter : posixAdapter;

/**
 * 获取临时端口号
 * @returns 临时端口号
 */
function acquireEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref().listen(0, () => {
      const address = server.address();
      if (address && typeof address !== "string") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("无法获取有效的IP端口。")));
      }
    });
    server.on("error", reject);
  });
}

/** 解析 QQNT 可执行文件路径；优先使用传入值，否则自动查找 */
function resolveQQPath(qqPathOverride: string): string {
  let qqExe: string;

  if (qqPathOverride) {
    qqExe = resolve(qqPathOverride);
  } else {
    const found = platform.findQQ();
    if (!found) throw new Error("未找到 QQ。请安装 QQNT 或在 QQ_PATH 填入路径");
    qqExe = found;
  }

  if (!existsSync(qqExe)) throw new Error(`路径不存在: ${qqExe}`);
  if (IS_WIN && !qqExe.endsWith("QQ.exe")) {
    const withExe = resolve(qqExe, "QQ.exe");
    if (existsSync(withExe)) qqExe = withExe;
  }

  return qqExe;
}

/** 校验 NapCat Shell 目录完整性，写入 webui.json 并返回各路径 */
function resolveNapcatPaths(napcatDir: string) {
  if (IS_WIN) {
    const required = ["NapCatWinBootMain.exe", "NapCatWinBootHook.dll", "qqnt.json"];
    const missing = required.filter((f) => !existsSync(resolve(napcatDir, f)));
    if (missing.length > 0) {
      throw new Error(`Shell 目录缺少文件: ${missing.join(", ")} (路径: ${napcatDir})`);
    }
  } else {
    if (!existsSync(resolve(napcatDir, "qqnt.json"))) {
      throw new Error(`NapCat 目录缺少 qqnt.json (路径: ${napcatDir})`);
    }
  }

  const mjsPath = resolve(napcatDir, "napcat.mjs");
  if (!existsSync(mjsPath)) throw new Error(`未找到 napcat.mjs (路径: ${napcatDir})`);

  const configDir = resolve(dirname(mjsPath), "config");
  const webuiToken = WEBUI_TOKEN_DEFAULT;

  const dynamicPort = 50000 + Math.floor(Math.random() * 15535);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    resolve(configDir, "webui.json"),
    JSON.stringify({ host: "127.0.0.1", port: dynamicPort, token: webuiToken }, null, 2),
  );

  return {
    shellDir: napcatDir,
    mjsPath,
    configDir,
    webuiPort: dynamicPort,
    webuiToken,
    qqntPath: resolve(napcatDir, "qqnt.json"),
  };
}

/** 确保 NapCat 文件完整，缺失时自动下载 */
export async function ensureNapcat(napcatDir: string, logger: NapCatLogger = noopLogger): Promise<void> {
  const required = IS_WIN
    ? ["napcat.mjs", "NapCatWinBootMain.exe", "NapCatWinBootHook.dll", "qqnt.json"]
    : ["napcat.mjs", "qqnt.json"];

  const missing = required.filter((f) => !existsSync(resolve(napcatDir, f)));
  if (missing.length === 0) {
    logger.info("napcat 文件完整，跳过下载");
    return;
  }

  logger.info({ missing }, "缺少 NapCat 文件，开始下载");
  const BAR_WIDTH = 20;
  let hasLoggedSize = false;
  let prevLineLength = 0;
  await downloadNapcat(
    napcatDir,
    (received, total) => {
      if (total && !hasLoggedSize) {
        hasLoggedSize = true;
        logger.info({ totalBytes: total }, `总大小: ${formatBytes(total)}`);
      }
      let line: string;
      if (total) {
        const pct = Math.round((received / total) * 100);
        const filled = Math.round((BAR_WIDTH * pct) / 100);
        const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
        line = `\r下载中 [${bar}] ${formatBytes(received)}/${formatBytes(total)} (${pct}%)`;
      } else {
        line = `\r已下载: ${formatBytes(received)}`;
      }
      prevLineLength = Math.max(prevLineLength, line.length);
      process.stderr.write(line.padEnd(prevLineLength));
    },
    () => process.stderr.write("\n"),
    logger,
  );

  const stillMissing = required.filter((f) => !existsSync(resolve(napcatDir, f)));
  if (stillMissing.length > 0) {
    throw new Error(`下载后仍缺少文件: ${stillMissing.join(", ")}`);
  }
  logger.info("napcat 已就绪");
}

/** 启动 NapCat 实例，返回操作句柄 */
export async function launchNapCat(config: NapCatConfig) {
  const logger = config.logger ?? noopLogger;
  logger.info({ qqId: config.qqId, napcatDir: config.napcatDir }, "准备启动 NapCat");

  const qqExe = resolveQQPath(config.qqPath);
  await ensureNapcat(config.napcatDir, logger);
  mkdirSync(config.runtimeDir, { recursive: true });
  await platform.cleanOrphans(config.runtimeDir, config.qqId);
  const handle = await platform.spawn({
    qqId: config.qqId,
    napcatDir: config.napcatDir,
    qqExe,
    mjsPath: resolve(config.napcatDir, "napcat.mjs"),
    qqntPath: resolve(config.napcatDir, "qqnt.json"),
    runtimeDir: config.runtimeDir,
    supervisorPaths: config.supervisorPaths,
    logger,
  });

  try {
    if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) {
      throw new Error(`NapCat supervisor 在初始化期间退出 (code=${handle.proc.exitCode})`);
    }
    const paths = resolveNapcatPaths(config.napcatDir);
    if (IS_WIN) {
      const fileUri = "file:///" + paths.mjsPath.replace(/\\/g, "/");
      writeFileSync(resolve(config.napcatDir, LOAD_SCRIPT_FILE), `(async () => {await import("${fileUri}")})()`);
    }

    // 记录 supervisor PID + QQ PID，PID 文件仅作为异常恢复的兜底。
    writePidFile(config.runtimeDir, config.qqId, {
      launcher: handle.proc.pid ?? 0,
      qq: 0,
      port: paths.webuiPort,
      createdAt: Date.now(),
    });

    // 内联 waitForWebUI 逻辑，启动即监听，移除缓冲区与超时设定
    const { promise: apiPromise, resolve: resolveApi, reject: rejectApi } = Promise.withResolvers<NapCatApi>();
    const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
    void readyPromise.catch(() => {});

    const ADAPTER_READY_RE = /\[AdapterManager\]\s*协议适配器初始化完成/;

    const stdoutTee = new PassThrough();
    let stdoutBuffer = "";
    handle.proc.stdout!.pipe(stdoutTee);
    stdoutTee.on("data", (d: Buffer) => {
      stdoutBuffer += d.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        logger.trace({ line }, "napcat stdout");

        if (!handle.qqPid) {
          const m = line.match(MAIN_PID_RE);
          if (m) {
            handle.qqPid = parseInt(m[1]!, 10);
            const rec = readPidFile(config.runtimeDir, config.qqId);
            if (rec) writePidFile(config.runtimeDir, config.qqId, { ...rec, qq: handle.qqPid });
          }
        }

        if (!handle.webuiPort) {
          const m = line.match(WEBUI_URL_RE);
          if (m) {
            handle.webuiPort = parseInt(m[1]!, 10);
            handle.webuiToken = m[2]!;
            createNapCatApi(handle.webuiPort, handle.webuiToken, logger).then(resolveApi).catch(rejectApi);
          }
        }

        if (ADAPTER_READY_RE.test(line)) resolveReady();
      }
    });

    handle.proc.stderr!.on("data", (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line) logger.error({ line }, "napcat stderr");
      }
    });
    handle.proc.stderr!.resume();
    handle.proc.on("error", (err) => {
      logger.error({ error: err }, "启动进程失败");
      rejectApi(err);
      rejectReady(err);
    });

    handle.proc.on("exit", (code) => {
      logger.info({ code }, "NapCat supervisor 退出");
      if (readPidFile(config.runtimeDir, config.qqId)?.launcher === handle.proc.pid) {
        deletePidFile(config.runtimeDir, config.qqId);
      }
      const error = new Error(`NapCat supervisor 已退出 (code=${code})`);
      rejectApi(error);
      rejectReady(error);
    });
    handle.proc.stdin?.write("1");

    let stopPromise: Promise<void> | undefined;

    return {
      qqId: config.qqId,
      get webuiPort() {
        return handle.webuiPort;
      },
      get webuiToken() {
        return handle.webuiToken;
      },
      waitForWebUI: () => apiPromise,
      waitForReady: () => readyPromise,
      stop: () =>
        (stopPromise ??= new Promise<void>((resolve, reject) => {
          if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) {
            resolve();
            return;
          }

          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            logger.warn({ pid: handle.proc.pid }, "NapCat supervisor 停止超时，强制结束");
            if (IS_WIN) {
              if (handle.proc.pid) forceKill(handle.proc.pid);
              finish();
              return;
            }
            settled = true;
            reject(new Error("NapCat supervisor 停止超时，进程组仍在清理中"));
          }, 8_000);
          timer.unref();
          handle.proc.once("exit", finish);
          if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) {
            finish();
            return;
          }
          handle.proc.stdin?.end();
        })),
    };
  } catch (error) {
    handle.proc.stdin?.end();
    throw error;
  }
}

function oneBotConfig(wsPort: number) {
  const config = structuredClone(oneBotConfigTemplate);
  config.network.websocketServers[0]!.port = wsPort;
  return config;
}

export interface StartBuiltinNapCatOptions extends NapCatConfig {
  onWebUiReady?: (url: string) => void;
}

/**
 * 启动内置 NapCat 进程
 * NapCat 进程树由 Rust supervisor 绑定父进程生命周期，无需在 TypeScript 中注册退出清理。
 * @param options 启动参数与宿主依赖
 * @returns 包含 WebSocket URL 和访问令牌的对象
 *  - wsUrl: WebSocket 连接 URL
 *  - accessToken: 访问令牌，用于身份验证
 */
export async function startBuiltinNapCat(options: StartBuiltinNapCatOptions) {
  const logger = options.logger ?? noopLogger;
  logger.info("启动内置 NapCat");
  let napcat: Awaited<ReturnType<typeof launchNapCat>> | undefined;
  try {
    napcat = await launchNapCat(options);
    const api = await napcat.waitForWebUI();
    const webuiUrl = `http://localhost:${napcat.webuiPort}/webui?token=${napcat.webuiToken}`;
    logger.info({ port: napcat.webuiPort, url: webuiUrl }, "NapCat WebUI 就绪");
    options.onWebUiReady?.(webuiUrl);

    const version = await api.getNapCatVersion();
    logger.info({ version }, `NapCat 版本: ${version}`);

    await napcat.waitForReady();
    logger.info("NapCat 协议适配器已就绪");

    const isLoggedIn = await api.checkLoginStatus();
    logger.info({ loggedIn: isLoggedIn }, `QQ 登录状态: ${isLoggedIn ? "已登录" : "未登录"}`);
    if (!isLoggedIn) {
      logger.warn({ url: webuiUrl }, "尚未登录 QQ，请访问 NapCat WebUI 完成登录：");
    }

    const wsPort = await acquireEphemeralPort();
    logger.info({ port: wsPort }, `临时 WebSocket 端口: ${wsPort}`);

    await api.setOB11Config(oneBotConfig(wsPort));
    logger.info("OneBot 配置已推送");

    return {
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      accessToken: "",
      webuiUrl,
    };
  } catch (error) {
    await napcat?.stop();
    throw error;
  }
}
