import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { binPath, projectPath, sidecarPath } from "@/utils/path";
import { logger } from "@/logger";

interface ReadyMessage {
  type: string;
}

interface RenderResultMessage {
  uuid: string;
  type: "result" | "error";
  image?: string;
  mime?: string;
  message?: string;
}

interface RenderOptions {
  /** source 是否为网页 URL；为 true 时渲染指定网页，否则渲染 HTML 字符串 */
  url?: boolean;
  width?: number;
  height?: number;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}

async function setupHtmlRenderer() {
  const localNodePath = process.platform === "win32" ? binPath("node.exe") : binPath("node");
  const nodeBin = existsSync(localNodePath) ? localNodePath : Bun.which("node");
  if (!nodeBin) {
    throw new Error("找不到 node 可执行文件，请在 bin 目录下放置 node.exe，或安装 Node.js");
  }

  const bundled = sidecarPath("render-html.cjs");
  const source = projectPath("packages", "playwright", "render-html.ts");
  const childPath = existsSync(bundled) ? bundled : source;

  const child = spawn(nodeBin, [childPath], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.unref();

  child.stdout?.on("data", (data) => logger.info({ data: data.toString() }, "render-html stdout"));
  child.stderr?.on("data", (data) => logger.error({ data: data.toString() }, "render-html stderr"));

  return {
    /**
     * 渲染 HTML 字符串或指定网页为图片
     * @param source 待渲染的 HTML 字符串；当 options.url 为 true 时为网页 URL
     * @param options 渲染选项
     * @returns 图片 Blob
     */
    render: async (source: string, options: RenderOptions = {}): Promise<Blob> => {
      const uuid = crypto.randomUUID();
      // 每次调用自包含：先监听仅匹配自身 uuid 的消息，收到后即移除监听，无需全局分发表
      const { image, mime } = await new Promise<{ image: string; mime: string }>((resolve, reject) => {
        const onMessage = (msg: RenderResultMessage) => {
          // 只处理与本次调用 uuid 匹配的消息，其余忽略
          if (msg.uuid !== uuid) return;
          // 收到自身消息后结束监听
          child.off("message", onMessage);
          if (msg.type === "error") return reject(new Error(msg.message ?? "渲染失败"));
          resolve({ image: msg.image!, mime: msg.mime! });
        };
        // 先注册监听再发送，避免响应早于监听到达
        child.on("message", onMessage);
        child.send({
          uuid,
          type: "render",
          html: options.url ? undefined : source,
          url: options.url ? source : undefined,
          width: options.width,
          height: options.height,
          full_page: options.fullPage,
          format: options.format,
          quality: options.quality,
        });
      });
      return new Blob([Buffer.from(image, "base64")], { type: mime });
    },
  };
}

type HtmlRenderer = Awaited<ReturnType<typeof setupHtmlRenderer>>;
let _instancePromise: Promise<HtmlRenderer> | null = null;

/**
 * 获取唯一的 HtmlRenderer 实例
 * @returns 返回唯一的 HtmlRenderer 实例
 */
export async function getHtmlRenderer() {
  if (!_instancePromise) _instancePromise = setupHtmlRenderer();
  return _instancePromise;
}
