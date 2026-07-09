#!/usr/bin/env bun
/**
 * napcat-loader — NapCat 编程式控制器（跨平台）
 *
 * API 操作：import { createNapCatApi, restartNapcatApi } from "./napcat-api/client"
 *
 * 可作为模块导入：import { launchNapCat } from "./napcat-loader"
 * 也可独立运行：bun run napcat-loader.ts
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createNapCatApi, restartNapcatApi } from "./client";
import { resolve, dirname } from "node:path";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { cwd } from "node:process";
import { downloadNapcat } from "./download";
import { OneBotClient } from "../onebot/onebot-client";
import { formatBytes } from "../utils/format";

const sleep = Bun.sleep;

const LOAD_SCRIPT_FILE = "loadNapCat.js";
const WEBUI_TOKEN_DEFAULT = "napcat-controller-token";
const IS_WIN = process.platform === "win32";

const WEBUI_URL_RE = /WebUi User Panel Url: http:\/\/127\.0\.0\.1:(\d+)\/webui\?token=(\S+)/;
const MAIN_PID_RE = /Main Process ID:(\d+)/;

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
  /** 清理残留的 NapCat 相关进程 */
  cleanOrphans(): void;
  /** 启动 NapCat 进程 */
  spawn(args: SpawnArgs): NapcatHandle;
  /** 停止 NapCat 进程 */
  stop(handle: NapcatHandle): Promise<void>;
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

  cleanOrphans() {
    try {
      const out = execSync('tasklist /NH /FO CSV /FI "IMAGENAME eq NapCatWinBootMain.exe" 2>nul', {
        encoding: "utf-8",
        timeout: 3000,
      });
      if (out.includes('"NapCatWinBootMain.exe"')) {
        execSync("taskkill /F /IM NapCatWinBootMain.exe /T 2>nul", { timeout: 3000 });
      }
    } catch {}
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
    console.log(` > ${launcher}`);
    console.log(` > 参数: ${spawnArgs.join(" ")}`);
    const proc = spawn(launcher, spawnArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    const handle: NapcatHandle = {
      proc,
      qqPid: 0,
      webuiPort: 0,
      webuiToken: "",
    };
    return handle;
  },

  async stop(handle) {
    const pid = handle.proc.pid;
    if (!pid) return;
    console.log(` > 正在停止 NapCat (PID=${pid}) …`);
    try {
      await restartNapcatApi("127.0.0.1", handle.webuiPort || 6099);
    } catch {}

    try {
      execSync(`taskkill /T /PID ${pid}`, { timeout: 3000, stdio: "pipe" });
    } catch {}

    const waitExit = new Promise<void>((resolve) => {
      if (handle.proc.exitCode !== null) return resolve();
      handle.proc.once("exit", () => resolve());
    });
    const launcherExited = await Promise.race([waitExit.then(() => true), sleep(1000).then(() => false)]);

    const qqAlive = handle.qqPid && handle.qqPid !== pid;
    if (!launcherExited || qqAlive) {
      if (!launcherExited) console.log(" … 优雅退出超时，强制终止");
      if (qqAlive) {
        try {
          execSync(`taskkill /F /PID ${handle.qqPid} /T 2>nul`, { timeout: 5000 });
        } catch {}
      }
      try {
        execSync(`taskkill /T /F /PID ${pid} 2>nul`, { timeout: 5000 });
      } catch {}
      await sleep(1000);
    }
    console.log(" ✓ NapCat 已停止");
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

  cleanOrphans() {
    // POSIX 无孤儿进程清理需求
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
    console.log(` > ${cmd} ${spawnArgs.join(" ")}`);
    const proc = spawn(cmd, spawnArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    const handle: NapcatHandle = {
      proc,
      qqPid: 0,
      webuiPort: 0,
      webuiToken: "",
    };
    return handle;
  },

  async stop(handle) {
    const pid = handle.proc.pid;
    if (!pid) return;
    console.log(` > 正在停止 NapCat (PID=${pid}) …`);
    try {
      execSync(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`, { timeout: 3000 });
    } catch {}
    await sleep(3000);
    try {
      execSync(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`, { timeout: 3000 });
    } catch {}
    console.log(" ✓ NapCat 已停止");
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
    console.log("napcat 文件完整，跳过下载");
    return;
  }

  console.log(`缺少 napcat.mjs 文件: ${missing.join(", ")}，开始下载…`);
  let totalSize = 0;
  await downloadNapcat(napcatDir, (received, total) => {
    if (total && !totalSize) {
      totalSize = total;
      console.log(`总大小: ${formatBytes(total)}`);
    }
    if (total) {
      process.stdout.write(
        `\r下载进度: ${formatBytes(received)}/${formatBytes(total)} (${Math.round((received / total) * 100)}%)`,
      );
    } else {
      process.stdout.write(`\r已下载: ${formatBytes(received)}`);
    }
  });
  if (totalSize) console.log();

  const stillMissing = required.filter((f) => !existsSync(resolve(napcatDir, f)));
  if (stillMissing.length > 0) {
    throw new Error(`下载后仍缺少文件: ${stillMissing.join(", ")}`);
  }
  console.log("napcat 已就绪");
}

/** 启动 NapCat 实例，返回操作句柄 */
export async function launchNapCat(config: NapCatConfig) {
  console.log(`QQ ID: ${config.qqId}`);
  console.log(`NapCat 路径: ${config.napcatDir}`);

  await ensureNapcat(config.napcatDir);
  const qqExe = resolveQQPath(config.qqPath);
  const paths = resolveNapcatPaths(config.napcatDir);

  platform.cleanOrphans();
  const handle = platform.spawn({
    qqId: config.qqId,
    napcatDir: paths.shellDir,
    qqExe,
    mjsPath: paths.mjsPath,
    qqntPath: paths.qqntPath,
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
    if (!handle.qqPid) {
      const m = text.match(MAIN_PID_RE);
      if (m) handle.qqPid = parseInt(m[1]!, 10);
    }
    if (!handle.webuiPort) {
      const m = text.match(WEBUI_URL_RE);
      if (m) {
        handle.webuiPort = parseInt(m[1]!, 10);
        handle.webuiToken = m[2]!;
        createNapCatApi(handle.webuiPort, handle.webuiToken).then(resolveApi).catch(rejectApi);
      }
    }
    if (text.match(ADAPTER_READY_RE)) resolveReady();
  });

  handle.proc.stderr!.on("data", (d: Buffer) => process.stderr.write("NAPCAT ERROR:" + d));
  handle.proc.on("error", (err) => {
    console.error(" ✗ 启动进程失败:", err.message);
    rejectApi(err);
  });
  handle.proc.on("exit", (code) => {
    console.log(` ⏹ NapCat 进程退出 (code=${code})`);
    rejectApi(new Error(`NapCat 进程已退出 (code=${code})`));
  });

  return {
    qqId: config.qqId,
    get webuiPort() {
      return handle.webuiPort;
    },
    waitForWebUI: () => apiPromise,
    waitForReady: () => readyPromise,
    stop: () => platform.stop(handle),
  };
}

function oneBotConfig(wsPort: number) {
  return {
    network: {
      httpServers: [],
      httpClients: [],
      httpSseServers: [],
      websocketServers: [
        {
          enable: true,
          name: "websocket-server",
          host: "127.0.0.1",
          port: wsPort,
          messagePostFormat: "array",
          reportSelfMessage: false,
          token: "",
          enableForcePushEvent: true,
          debug: false,
          heartInterval: 30000,
        },
      ],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: "",
    enableLocalFile2Url: false,
    parseMultMsg: false,
  };
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
    napcatDir: resolve(cwd(), "data", "runtime", "napcat"),
    qqPath: "",
  };

  console.log("启动内置 NapCat...");
  const napcat = await launchNapCat(napcatConfig);
  const api = await napcat.waitForWebUI();
  console.log(`NapCat WebUI 端口: ${napcat.webuiPort}`);

  const version = await api.getNapCatVersion();
  console.log(`NapCat 版本: ${version}`);

  await napcat.waitForReady();
  console.log("NapCat 协议适配器已就绪");

  const isLoggedIn = await api.checkLoginStatus();
  console.log(`QQ 登录状态: ${isLoggedIn ? "已登录" : "未登录"}`);

  const wsPort = await acquireEphemeralPort();
  console.log(`临时 WebSocket 端口: ${wsPort}`);

  await api.setOB11Config(oneBotConfig(wsPort));
  console.log("OneBot 配置已推送");

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
    console.log(msg);
  });
  await client.connect();
  // 保持程序运行，等待信号
  await new Promise(() => {});
}
