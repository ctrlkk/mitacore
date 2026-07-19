import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createNapCatApi, restartNapcatApi } from "./client";
import { resolve, dirname } from "node:path";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { downloadNapcat } from "./download";
import { readPidFile, writePidFile } from "./pid-file";
import { OneBotClient } from "@/onebot/onebot-client";
import { formatBytes } from "@/utils/format";
import { dataPath } from "@/utils/path";
import { logger } from "@/logger";
import { registerShutdownHook } from "@/utils/shutdown";
import config from "./onebot-config.json";

const LOAD_SCRIPT_FILE = "loadNapCat.js";
const WEBUI_TOKEN_DEFAULT = Math.random().toString(36).substring(2, 15);
const IS_WIN = process.platform === "win32";

const WEBUI_URL_RE = /WebUi User Panel Url: http:\/\/127\.0\.0\.1:(\d+)\/webui\?token=(\S+)/;
const MAIN_PID_RE = /Main Process ID:(\d+)/;

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
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
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
}

/** 启动 NapCat 所需参数 */
interface SpawnArgs {
  qqId: string;
  napcatDir: string;
  qqExe: string;
  mjsPath: string;
  qqntPath: string;
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
  /** 清理上次启动残留的进程（读 PID 文件 + 端口反查） */
  cleanOrphans(qqId: string): Promise<void>;
  /** 启动 NapCat 进程 */
  spawn(args: SpawnArgs): NapcatHandle;
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

  async cleanOrphans(qqId: string): Promise<void> {
    const rec = readPidFile(qqId);
    if (!rec) return;
    if (rec.qq > 0 && isPidAlive(rec.qq)) {
      logger.info({ qqId, qq: rec.qq }, "检测到残留 QQ 进程，正在清理");
      forceKill(rec.qq);
    }
    if (rec.launcher > 0 && isPidAlive(rec.launcher)) {
      logger.info({ qqId, launcher: rec.launcher }, "检测到残留 launcher，正在清理");
      forceKill(rec.launcher);
    }
  },

  spawn(args) {
    const { qqId, napcatDir, qqExe, mjsPath, qqntPath } = args;

    const fileUri = "file:///" + mjsPath.replace(/\\/g, "/");
    writeFileSync(resolve(napcatDir, LOAD_SCRIPT_FILE), `(async () => {await import("${fileUri}")})()`);

    const env: Record<string, string> = {
      NAPCAT_PATCH_PACKAGE: qqntPath,
      NAPCAT_LOAD_PATH: resolve(napcatDir, LOAD_SCRIPT_FILE),
      NAPCAT_INJECT_PATH: resolve(napcatDir, "NapCatWinBootHook.dll"),
      NAPCAT_LAUNCHER_PATH: resolve(napcatDir, "NapCatWinBootMain.exe"),
      NAPCAT_MAIN_PATH: mjsPath,
    };

    const launcher = resolve(napcatDir, "NapCatWinBootMain.exe");
    const spawnArgs = [resolve(dirname(qqExe), "QQ.exe"), resolve(napcatDir, "NapCatWinBootHook.dll"), qqId];
    logger.info({ launcher, args: spawnArgs }, "启动 NapCat launcher (win32)");
    const proc = spawn(launcher, spawnArgs, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

  async cleanOrphans(qqId: string): Promise<void> {
    const rec = readPidFile(qqId);
    if (!rec) return;
    if (rec.qq > 0 && isPidAlive(rec.qq)) {
      logger.info({ qqId, qq: rec.qq }, "检测到残留 QQ 进程，正在清理");
      forceKill(rec.qq);
    }
    if (rec.launcher > 0 && isPidAlive(rec.launcher)) {
      logger.info({ qqId, launcher: rec.launcher }, "检测到残留 launcher，正在清理");
      forceKill(rec.launcher);
    }
  },

  spawn(args) {
    const { qqId, qqExe, mjsPath, qqntPath } = args;

    const env: Record<string, string> = {
      NAPCAT_PATCH_PACKAGE: qqntPath,
      NAPCAT_MAIN_PATH: mjsPath,
      NAPCAT_DISABLE_MULTI_PROCESS: "1",
      NAPCAT_DISABLE_PIPE: "1",
    };

    const useXvfb = !process.env.DISPLAY && existsSync("/usr/bin/xvfb-run");
    const cmd = useXvfb ? "xvfb-run" : qqExe;
    const spawnArgs = useXvfb ? ["-a", qqExe, "--no-sandbox", "-q", qqId] : ["--no-sandbox", "-q", qqId];
    logger.info({ cmd, args: spawnArgs }, "启动 NapCat launcher (posix)");
    const proc = spawn(cmd, spawnArgs, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
export async function ensureNapcat(napcatDir: string): Promise<void> {
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
  );

  const stillMissing = required.filter((f) => !existsSync(resolve(napcatDir, f)));
  if (stillMissing.length > 0) {
    throw new Error(`下载后仍缺少文件: ${stillMissing.join(", ")}`);
  }
  logger.info("napcat 已就绪");
}

/** 启动 NapCat 实例，返回操作句柄 */
export async function launchNapCat(config: NapCatConfig) {
  logger.info({ qqId: config.qqId, napcatDir: config.napcatDir }, "准备启动 NapCat");

  await ensureNapcat(config.napcatDir);
  const qqExe = resolveQQPath(config.qqPath);
  const paths = resolveNapcatPaths(config.napcatDir);

  await platform.cleanOrphans(config.qqId);
  const handle = platform.spawn({
    qqId: config.qqId,
    napcatDir: paths.shellDir,
    qqExe,
    mjsPath: paths.mjsPath,
    qqntPath: paths.qqntPath,
  });

  // 记录本次启动的 PID + 端口，供下次启动的 cleanOrphans 清理残留
  writePidFile(config.qqId, {
    launcher: handle.proc.pid ?? 0,
    qq: 0,
    port: paths.webuiPort,
    createdAt: Date.now(),
  });

  // 内联 waitForWebUI 逻辑，启动即监听，移除缓冲区与超时设定
  let resolveApi!: (api: NapCatApi) => void;
  let rejectApi!: (err: any) => void;
  const apiPromise = new Promise<NapCatApi>((resolve, reject) => {
    resolveApi = resolve;
    rejectApi = reject;
  });

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const ADAPTER_READY_RE = /\[AdapterManager\]\s*协议适配器初始化完成/;

  const stdoutTee = new PassThrough();
  handle.proc.stdout!.pipe(stdoutTee);
  stdoutTee.on("data", (d: Buffer) => {
    const text = d.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) logger.trace({ line }, "napcat stdout");
    }
    // 记录 PID
    if (!handle.qqPid) {
      const m = text.match(MAIN_PID_RE);
      if (m) {
        handle.qqPid = parseInt(m[1]!, 10);
        const rec = readPidFile(config.qqId);
        if (rec) writePidFile(config.qqId, { ...rec, qq: handle.qqPid });
      }
    }
    // 创建 API 实例
    if (!handle.webuiPort) {
      const m = text.match(WEBUI_URL_RE);
      if (m) {
        handle.webuiPort = parseInt(m[1]!, 10);
        handle.webuiToken = m[2]!;
        createNapCatApi(handle.webuiPort, handle.webuiToken).then(resolveApi).catch(rejectApi);
      }
    }
    // 通知准备就绪
    if (text.match(ADAPTER_READY_RE)) resolveReady();
  });

  handle.proc.stderr!.on("data", (d: Buffer) => {
    const text = d.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) logger.error({ line }, "napcat stderr");
    }
  });
  handle.proc.on("error", (err) => {
    logger.error({ error: err }, "启动进程失败");
    rejectApi(err);
  });

  handle.proc.on("exit", (code) => {
    logger.info({ code }, "NapCat 进程退出");
    if (handle.proc.pid) forceKill(handle.proc.pid);
    forceKill(handle.qqPid);
    rejectApi(new Error(`NapCat 进程已退出 (code=${code})`));
  });

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
    stop: () => {
      if (handle.proc.pid) forceKill(handle.proc.pid);
      forceKill(handle.qqPid);
    },
  };
}

function oneBotConfig(wsPort: number) {
  config.network.websocketServers[0]!.port = wsPort;
  return config;
}

/**
 * 启动内置 NapCat 进程
 * @param qqId QQ ID
 * @returns 包含 WebSocket URL、访问令牌和停止函数的对象
 *  - wsUrl: WebSocket 连接 URL
 *  - accessToken: 访问令牌，用于身份验证
 *  - stop: 停止 NapCat 进程的函数
 */
export async function startBuiltinNapCat(qqId: string) {
  const napcatConfig: NapCatConfig = {
    qqId,
    napcatDir: dataPath("runtime", "napcat"),
    qqPath: "",
  };

  logger.info("启动内置 NapCat");
  const napcat = await launchNapCat(napcatConfig);
  const api = await napcat.waitForWebUI();
  logger.info(
    { port: napcat.webuiPort, url: `http://localhost:${napcat.webuiPort}/webui?token=${napcat.webuiToken}` },
    "NapCat WebUI 就绪",
  );

  const version = await api.getNapCatVersion();
  logger.info({ version }, `NapCat 版本: ${version}`);

  await napcat.waitForReady();
  logger.info("NapCat 协议适配器已就绪");

  const isLoggedIn = await api.checkLoginStatus();
  logger.info({ loggedIn: isLoggedIn }, `QQ 登录状态: ${isLoggedIn ? "已登录" : "未登录"}`);

  const wsPort = await acquireEphemeralPort();
  logger.info({ port: wsPort }, `临时 WebSocket 端口: ${wsPort}`);

  await api.setOB11Config(oneBotConfig(wsPort));
  logger.info("OneBot 配置已推送");

  return {
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    accessToken: "",
    stop: napcat.stop,
  };
}

if (import.meta.main) {
  const napcat = await startBuiltinNapCat("2790285434");
  const client = new OneBotClient({
    url: napcat.wsUrl,
    accessToken: napcat.accessToken,
    reconnect: true,
  });
  client.onMessage((msg) => {
    logger.debug({ msg }, "收到 OneBot 消息");
  });
  await client.connect();
  await Bun.sleep(1000);
  registerShutdownHook("NapCat", async () => {
    napcat.stop();
    logger.info("NapCat 进程已关闭");
  });
}
