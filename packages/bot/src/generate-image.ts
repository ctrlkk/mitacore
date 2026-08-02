import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { findExecutable } from "@/utils/find-executable";
import { binPath, projectPath, sidecarPath } from "@/utils/path";
import { logger } from "@/logger";
import { env } from "node:process";

interface ReadyMessage {
  type: string;
  port: number;
}

interface GenerateResult {
  urls?: string[];
  error?: string;
}

async function setupImageGenerator() {
  const localNodePath = process.platform === "win32" ? binPath("node.exe") : binPath("node");
  const nodeBin = existsSync(localNodePath) ? localNodePath : findExecutable("node");

  if (!nodeBin) {
    throw new Error("找不到 node 可执行文件，请在 bin 目录下放置 node.exe，或安装 Node.js");
  }

  const bundled = sidecarPath("playwright.cjs");
  const source = projectPath("packages", "playwright", "main.ts");
  const childPath = existsSync(bundled) ? bundled : source;

  const child = spawn(nodeBin, [childPath], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout?.on("data", (data) => {
    logger.info({ data: data.toString() }, "playwright stdout");
  });
  child.stderr?.on("data", (data) => {
    logger.error({ data: data.toString() }, "playwright stderr");
  });

  process.on("exit", (sig) => {
    if (child.killed) return;
    child.kill(sig);
  });

  child.on("exit", (code) => {
    if (code === 0) return;
    logger.error({ code }, "playwright 异常退出");
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onMessage = (msg: ReadyMessage) => {
      if (msg.type === "ready" && typeof msg.port === "number") {
        cleanupListeners();
        resolve(msg.port);
      }
    };

    const onError = (e: Error) => {
      cleanupListeners();
      reject(e);
    };

    const onExit = (code: number | null) => {
      if (code !== 0) {
        cleanupListeners();
        reject(new Error(`playwright 启动失败，exit code=${code}`));
      }
    };

    const cleanupListeners = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    /**
     * GET /page/screenshot，返回 JPEG 图片 Blob
     * @param full 是否获取全屏截图
     * @returns JPEG 图片 Blob
     * */
    screenshot: async (full = false) => {
      const res = await fetch(`${baseUrl}/page/screenshot?full=${full}`);
      return await res.blob();
    },

    /**
     * POST /generate，返回生成的图片 URL 列表
     * @param prompt 生成提示
     * @param images 生成时需要的图片
     * @returns 生成的图片 URL 列表
     * */
    generate: async (prompt: string, images: File[] = []) => {
      const form = new FormData();
      form.append("prompt", prompt);
      for (const img of images) form.append("images", img);

      const res = await fetch(`${baseUrl}/generate`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as GenerateResult;
      if (!res.ok) throw new Error(`生成失败 (HTTP ${res.status}): ${JSON.stringify(data)}`);
      return data.urls ?? [];
    },
  };
}

type ImageGenerator = Awaited<ReturnType<typeof setupImageGenerator>>;
let _instancePromise: Promise<ImageGenerator> | null = null;

/**
 * 获取唯一的 ImageGenerator 实例
 * @returns 返回唯一的 ImageGenerator 实例
 */
export async function getImageGenerator() {
  if (!_instancePromise) {
    _instancePromise = setupImageGenerator();
  }
  return _instancePromise;
}

if (import.meta.main) {
  const { generate } = await getImageGenerator();
  const urls = await generate("一张基于《贤惠幼妻仙狐小姐》的二次创作，仙狐小姐和用户（不显示在镜头中）在沙滩玩耍");
  logger.info({ urls }, "图像生成结果");
}
