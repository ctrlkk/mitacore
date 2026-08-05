import { app, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../../..", import.meta.url));
const port = 14251;
let bot: ChildProcess | undefined;
let webui: ChildProcess | undefined;
let quitting = false;
let botRestartTimer: NodeJS.Timeout | undefined;

function runtimePath(...segments: string[]) {
  return app.isPackaged ? join(process.resourcesPath, "runtime", ...segments) : join(rootDir, ...segments);
}

function startBot() {
  if (app.isPackaged) {
    const executable = process.platform === "win32" ? "app.exe" : "app";
    const entry = runtimePath(executable);
    if (!existsSync(entry)) throw new Error(`找不到 bot 运行文件：${entry}`);
    bot = spawn(entry, [], { cwd: runtimePath(), stdio: "inherit", windowsHide: true });
  } else {
    bot = spawn("bun", ["run", "packages/bot/src/index.ts"], {
      cwd: rootDir,
      stdio: "inherit",
      windowsHide: true,
    });
    webui = spawn("bun", ["run", "--cwd", "packages/webui", "dev", "--host", "127.0.0.1"], {
      cwd: rootDir,
      stdio: "inherit",
      windowsHide: true,
    });
  }
  bot.once("exit", () => {
    bot = undefined;
    if (quitting) return;
    botRestartTimer = setTimeout(() => {
      botRestartTimer = undefined;
      startBot();
    }, 500);
  });
}

async function waitForBot() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // bot 还在启动，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("bot WebUI 在 30 秒内没有启动");
}

async function waitForUrl(url: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 开发服务器还在启动，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`WebUI 在 30 秒内没有启动：${url}`);
}

function isNapCatWebUiUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname === "/webui";
  } catch {
    return false;
  }
}

async function createWindow() {
  await waitForBot();
  const url = app.isPackaged ? `http://127.0.0.1:${port}` : "http://127.0.0.1:5173";
  if (!app.isPackaged) await waitForUrl(url);
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js"),
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isNapCatWebUiUrl(url)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: window,
        width: 1200,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });
  await window.loadURL(url);
}

app.whenReady().then(async () => {
  startBot();
  await createWindow();
});

app.on("before-quit", () => {
  quitting = true;
  if (botRestartTimer) clearTimeout(botRestartTimer);
  bot?.kill();
  webui?.kill();
  bot = undefined;
  webui = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
