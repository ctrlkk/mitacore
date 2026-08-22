import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESTART_EXIT_CODE = 75;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const installRoot = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(installRoot, ".env");
const appPath = resolve(installRoot, "app.mjs");

if (existsSync(configPath)) process.loadEnvFile(configPath);

async function waitForExit(child) {
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal });
    };
    child.once("exit", finish);
    child.once("error", (error) => {
      console.error("启动 Bot 失败", error);
      finish(1, null);
    });
  });
}

async function run() {
  let stopping = false;
  let terminate;
  let webUiPort;

  const stopSupervisor = () => terminate?.();
  process.once("SIGINT", stopSupervisor);
  process.once("SIGTERM", stopSupervisor);

  try {
    while (!stopping) {
      const child = fork(appPath, process.argv.slice(2), {
        cwd: installRoot,
        env: { ...process.env, ...(webUiPort ? { WEBUI_PORT: String(webUiPort) } : {}) },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });

      child.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready" && typeof message.port === "number") {
          webUiPort = message.port;
        }
      });

      const timeout = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        console.warn("Bot 停止超时，强制结束进程");
        child.kill("SIGKILL");
      };
      let shutdownTimer;
      terminate = () => {
        if (stopping) return;
        stopping = true;
        child.kill("SIGTERM");
        shutdownTimer = setTimeout(timeout, SHUTDOWN_TIMEOUT_MS);
        shutdownTimer.unref();
      };

      const { code, signal } = await waitForExit(child);
      clearTimeout(shutdownTimer);
      terminate = undefined;

      if (stopping) return code ?? (signal ? 1 : 0);
      if (code === RESTART_EXIT_CODE) {
        console.info("正在重新启动 Bot");
        continue;
      }
      return code ?? (signal ? 1 : 0);
    }
  } finally {
    terminate = undefined;
  }
  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("supervisor 异常退出", error);
    process.exitCode = 1;
  });
