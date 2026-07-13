import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { binPath, projectPath, sidecarPath } from "@/utils/path";
import { logger } from "@/logger";

const localNodePath = process.platform === "win32" ? binPath("node.exe") : binPath("node");

export async function setupImageGenerator() {
  let nodeBin: string | null = null;
  if (existsSync(localNodePath)) {
    nodeBin = localNodePath;
  } else {
    nodeBin = Bun.which("node");
  }
  if (!nodeBin) {
    throw new Error("找不到 node 可执行文件，请在 bin 目录下放置 node.exe，或安装 Node.js");
  }

  // 优先用打包产物（<installRoot>/sidecar/playwright.cjs），开发时 fallback 到源码
  const bundled = sidecarPath("playwright.cjs");
  const source = projectPath("packages", "playwright", "main.ts");
  const childPath = existsSync(bundled) ? bundled : source;
  const child = spawn(nodeBin, [childPath], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    // 不要 detached: Windows 上 detached 会让子进程脱离父 Job Object，反而泄漏
    // 默认行为：子进程加入父 Job，父死时 Job 关闭自动回收子进程
    windowsHide: true,
  });

  // 父进程任何形式的退出都要保证子进程被回收
  let killed = false;
  const killChild = (sig: NodeJS.Signals = "SIGTERM") => {
    if (killed || child.killed) return;
    killed = true;
    child.kill(sig);
    // 兜底强杀
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000).unref();
  };

  process.on("exit", () => killChild());
  process.on("SIGINT", () => {
    killChild();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killChild();
    process.exit(143);
  });

  // 子进程提前非正常退出，父进程也别卡着
  child.on("exit", (code) => {
    if (!killed && code !== 0) {
      logger.error({ code }, "playwright 异常退出");
      process.exit(code ?? 1);
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    child.on("message", (msg: unknown) => {
      if (typeof msg === "object" && msg !== null && "type" in msg && "port" in msg) {
        const m = msg as { type: string; port: number };
        if (m.type === "ready" && typeof m.port === "number") {
          resolve(m.port);
        }
      }
    });
    child.on("error", (e: Error) => {
      reject(e);
    });
    child.on("exit", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`playwright 启动失败，exit code=${code}`));
      }
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    /** GET /page/screenshot，返回 JPEG 图片 Blob */
    screenshot: async (full = false) => {
      const res = await fetch(`${baseUrl}/page/screenshot?full=${full}`);
      return await res.blob();
    },

    /** POST /generate，返回生成的图片 URL 列表 */
    generate: async (prompt: string, images: File[] = []) => {
      const form = new FormData();
      form.append("prompt", prompt);
      for (const img of images) form.append("images", img);
      const res = await fetch(`${baseUrl}/generate`, { method: "POST", body: form });
      const data = (await res.json()) as { urls?: string[]; error?: string };
      if (!res.ok) throw new Error(`生成失败 (HTTP ${res.status}): ${JSON.stringify(data)}`);
      return data.urls ?? [];
    },
  };
}

if (import.meta.main) {
  const { generate } = await setupImageGenerator();
  const urls = await generate("一张基于《贤惠幼妻仙狐小姐》的二次创作，仙狐小姐和用户（不显示在镜头中）在沙滩玩耍");
  logger.info({ urls }, "图像生成结果");
}
