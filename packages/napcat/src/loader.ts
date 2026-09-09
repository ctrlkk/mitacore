import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createNapCatApi, type NapCatLoginStatus } from "./client.ts";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { downloadNapcat } from "./download.ts";
import { deletePidFile, readPidFile, writePidFile } from "./pid-file.ts";
import { noopLogger, type NapCatLogger } from "./logger.ts";
import { linuxAdapter } from "./loader/linux.ts";
import type { PlatformAdapter } from "./loader/platform.ts";
import { forceKillWindowsProcess, windowsAdapter } from "./loader/windows.ts";
import oneBotConfigTemplate from "./onebot-config.json" with { type: "json" };

const LOAD_SCRIPT_FILE = "loadNapCat.js";
const WEBUI_TOKEN_DEFAULT = Math.random().toString(36).substring(2, 15);
const IS_WIN = process.platform === "win32";
const WEBUI_CONNECT_TIMEOUT_MS = 30_000;
const LOGIN_STATUS_POLL_INTERVAL_MS = 5_000;

const MAIN_PID_RE = /Main Process ID:(\d+)/;
const QR_CODE_URL_RE = /二维码解码URL:\s*(\S+)/;
const LOGIN_ERROR_RE = /\[Core\]\s*\[Login\]\s*Login Error.*$/;

function redactNapCatOutput(text: string): string {
  return text
    .replace(/([?&](?:token|credential|authorization|sig|password)=)[^&\s]+/gi, "$1***")
    .replace(/(Bearer\s+)\S+/gi, "$1***");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, unitIndex)).toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

/** 从 QQ 安装目录读取当前 NTQQ 版本；版本信息不可用时不影响启动。 */
function getQQVersion(qqExe: string): string | undefined {
  try {
    const content = readFileSync(resolve(dirname(qqExe), "versions", "config.json"), "utf8");
    const config: unknown = JSON.parse(content);
    if (!config || typeof config !== "object" || !("curVersion" in config)) return undefined;
    const version = config.curVersion;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 检查 POSIX 进程是否存活。 */
function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  /** Linux LD_PRELOAD 注入器候选路径，按顺序查找 */
  linuxInjectorPaths: string[];
  /** 接入宿主应用的日志器 */
  logger?: NapCatLogger;
  /** 向宿主报告来自 QQ 内核回调的登录状态 */
  onLoginStatus?: (status: NapCatLoginStatus) => void;
}

function getPlatformAdapter(): PlatformAdapter {
  if (IS_WIN) return windowsAdapter;
  if (process.platform === "linux") return linuxAdapter;
  throw new Error(`内置 NapCat 暂不支持当前平台: ${process.platform}`);
}

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
function resolveQQPath(qqPathOverride: string, platform: PlatformAdapter): string {
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

/** 校验 NapCat Shell 目录完整性，写入 webui.json 并返回各路径。 */
function resolveNapcatPaths(napcatDir: string) {
  if (IS_WIN) {
    const required = ["NapCatWinBootMain.exe", "NapCatWinBootHook.dll", "qqnt.json"];
    const missing = required.filter((f) => !existsSync(resolve(napcatDir, f)));
    if (missing.length > 0) {
      throw new Error(`Shell 目录缺少文件: ${missing.join(", ")} (路径: ${napcatDir})`);
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
    : ["napcat.mjs"];

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

  const platform = getPlatformAdapter();
  const qqExe = resolveQQPath(config.qqPath, platform);
  await ensureNapcat(config.napcatDir, logger);
  mkdirSync(config.runtimeDir, { recursive: true });
  await platform.cleanOrphans(config.runtimeDir, config.qqId, qqExe);
  const handle = await platform.spawn({
    qqId: config.qqId,
    napcatDir: config.napcatDir,
    qqExe,
    mjsPath: resolve(config.napcatDir, "napcat.mjs"),
    qqntPath: resolve(config.napcatDir, "qqnt.json"),
    runtimeDir: config.runtimeDir,
    supervisorPaths: config.supervisorPaths,
    linuxInjectorPaths: config.linuxInjectorPaths,
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

    // WebUI 的端口和令牌由上方写入的 webui.json 决定，不能依赖可能变动的 stdout 文案。
    handle.webuiPort = paths.webuiPort;
    handle.webuiToken = paths.webuiToken;
    const { promise: apiPromise, resolve: resolveApi, reject: rejectApi } = Promise.withResolvers<NapCatApi>();
    const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
    void readyPromise.catch(() => {});
    let webUiConnectStarted = false;
    let webUiConnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connectWebUi = () => {
      if (webUiConnectStarted) return;
      webUiConnectStarted = true;
      webUiConnectTimer = setTimeout(() => {
        const error = new Error(`等待 NapCat WebUI 连接超时（${WEBUI_CONNECT_TIMEOUT_MS / 1000} 秒）`);
        rejectApi(error);
      }, WEBUI_CONNECT_TIMEOUT_MS);
      webUiConnectTimer.unref();
      createNapCatApi(handle.webuiPort, handle.webuiToken, logger, WEBUI_CONNECT_TIMEOUT_MS - 1_000)
        .then((api) => {
          clearTimeout(webUiConnectTimer);
          resolveApi(api);
        })
        .catch((error) => {
          clearTimeout(webUiConnectTimer);
          rejectApi(error);
        });
    };

    const ADAPTER_READY_RE = /\[AdapterManager\]\s*协议适配器初始化完成/;

    const handleOutputLine = (line: string) => {
      const qrcode = line.match(QR_CODE_URL_RE)?.[1];
      if (qrcode) {
        config.onLoginStatus?.({ isLoggedIn: false, qrcodeContent: qrcode });
      }

      const loginError = line.match(LOGIN_ERROR_RE)?.[0];
      if (loginError) {
        config.onLoginStatus?.({ isLoggedIn: false, loginError: redactNapCatOutput(loginError) });
      }

      if (ADAPTER_READY_RE.test(line)) {
        config.onLoginStatus?.({ isLoggedIn: true });
        resolveReady();
      }
    };

    const stdoutTee = new PassThrough();
    let stdoutBuffer = "";
    handle.proc.stdout!.pipe(stdoutTee);
    stdoutTee.on("data", (d: Buffer) => {
      stdoutBuffer += d.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        logger.trace({ line: redactNapCatOutput(line) }, "napcat stdout");

        if (!handle.qqPid) {
          const m = line.match(MAIN_PID_RE);
          if (m) {
            handle.qqPid = parseInt(m[1]!, 10);
            const rec = readPidFile(config.runtimeDir, config.qqId);
            if (rec) writePidFile(config.runtimeDir, config.qqId, { ...rec, qq: handle.qqPid });
          }
        }

        handleOutputLine(line);
      }
    });

    handle.proc.stderr!.on("data", (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line) {
          logger.error({ line: redactNapCatOutput(line) }, "napcat stderr");
          handleOutputLine(line);
        }
      }
    });
    handle.proc.stderr!.resume();
    handle.proc.on("error", (err) => {
      logger.error({ error: err }, "启动进程失败");
      clearTimeout(webUiConnectTimer);
      rejectApi(err);
      rejectReady(err);
    });

    handle.proc.on("exit", (code) => {
      logger.info({ code }, "NapCat supervisor 退出");
      const rec = readPidFile(config.runtimeDir, config.qqId);
      if (rec && rec.launcher === handle.proc.pid) {
        if (IS_WIN || !rec.qq || !isPidAlive(rec.qq)) {
          deletePidFile(config.runtimeDir, config.qqId);
        }
      }
      const error = new Error(`NapCat supervisor 已退出 (code=${code})`);
      clearTimeout(webUiConnectTimer);
      rejectApi(error);
      rejectReady(error);
    });
    handle.proc.stdin?.write("1");

    let stopPromise: Promise<void> | undefined;

    return {
      qqId: config.qqId,
      qqVersion: getQQVersion(qqExe),
      get webuiPort() {
        return handle.webuiPort;
      },
      get webuiToken() {
        return handle.webuiToken;
      },
      startWebUiConnection: connectWebUi,
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
              if (handle.proc.pid) forceKillWindowsProcess(handle.proc.pid);
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

function oneBotConfigWithPort(config: Record<string, unknown>, wsPort: number) {
  const current = structuredClone(config) as {
    network?: { websocketServers?: Array<{ name?: unknown; port?: unknown }> };
  };
  const server = current.network?.websocketServers?.find((item) => item.name === "websocket-server");
  if (!server) return oneBotConfig(wsPort);
  server.port = wsPort;
  return current;
}

export interface StartBuiltinNapCatOptions extends NapCatConfig {
  onWebUiReady?: (url: string) => void;
  onVersion?: (versions: { qqVersion?: string; napcatVersion?: string }) => void;
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
  const wsPort = await acquireEphemeralPort();
  logger.info({ port: wsPort }, `预分配 OneBot WebSocket 端口: ${wsPort}`);
  let napcat: Awaited<ReturnType<typeof launchNapCat>> | undefined;
  try {
    napcat = await launchNapCat(options);
    if (!napcat) throw new Error("NapCat 启动后未返回运行句柄");
    const startedNapcat = napcat;
    const webuiUrl = `http://localhost:${startedNapcat.webuiPort}/webui?token=${startedNapcat.webuiToken}`;

    options.onVersion?.({ qqVersion: startedNapcat.qqVersion });
    await startedNapcat.waitForReady();
    logger.info("NapCat 协议适配器已就绪，QQ 已登录");

    startedNapcat.startWebUiConnection();
    const apiPromise = startedNapcat.waitForWebUI();
    const napcatVersionPromise = apiPromise.then(async (api) => {
      const napcatVersion = await api.getNapCatVersion();
      logger.info({ version: napcatVersion }, `NapCat 版本: ${napcatVersion}`);
      options.onVersion?.({ qqVersion: startedNapcat.qqVersion, napcatVersion });
      return napcatVersion;
    });
    void napcatVersionPromise.catch(() => {});

    const api = await apiPromise;

    // 由 NapCat 自己持久化配置并重载 OneBot 网络适配器。
    logger.info({ port: startedNapcat.webuiPort }, "NapCat WebUI 就绪");
    const currentConfig = await api.getOB11Config();
    await api.setOB11Config(oneBotConfigWithPort(currentConfig, wsPort));
    logger.info({ port: wsPort }, "OneBot WebSocket 配置已更新，等待连接");
    options.onWebUiReady?.(webuiUrl);
    const napcatVersion = await napcatVersionPromise;

    const reportLoginStatus = async () => {
      try {
        options.onLoginStatus?.(await api.getLoginStatus());
      } catch (error) {
        // WebUI 短暂不可用不能推断 QQ 已下线，等待下次轮询即可。
        logger.debug({ err: error }, "获取 NapCat QQ 登录状态失败");
      }
    };
    void reportLoginStatus();
    const loginStatusTimer = setInterval(() => void reportLoginStatus(), LOGIN_STATUS_POLL_INTERVAL_MS);
    loginStatusTimer.unref();

    return {
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      accessToken: "",
      webuiUrl,
      qqVersion: startedNapcat.qqVersion,
      napcatVersion,
    };
  } catch (error) {
    await napcat?.stop();
    throw error;
  }
}
