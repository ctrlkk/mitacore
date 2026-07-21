import type { Browser, Page } from "playwright";
import { chromium } from "playwright-extra";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const NAVIGATE_TIMEOUT_MS = 60_000;

interface RenderRequest {
  uuid: string;
  type: "render";
  html?: string;
  url?: string;
  width?: number;
  height?: number;
  full_page?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}

async function main() {
  const browser: Browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page: Page = await browser.newPage();

  process.on("message", async (msg: RenderRequest) => {
    if (msg.type !== "render") return;
    try {
      await page.setViewportSize({
        width: msg.width ?? DEFAULT_WIDTH,
        height: msg.height ?? DEFAULT_HEIGHT,
      });
      // url 优先：渲染指定网页；否则渲染传入的 html 字符串
      if (msg.url) {
        await page.goto(msg.url, { waitUntil: "networkidle", timeout: NAVIGATE_TIMEOUT_MS });
      } else {
        await page.setContent(msg.html ?? "", { waitUntil: "networkidle" });
      }
      const format = msg.format ?? "png";
      const buf = await page.screenshot({
        type: format,
        // png 不接受 quality，仅 jpeg 时传入
        quality: format === "jpeg" ? (msg.quality ?? 80) : undefined,
        fullPage: msg.full_page ?? true,
        animations: "disabled",
        caret: "hide",
      });
      // 原样回传 uuid，供调用方匹配自身请求
      process.send?.({
        uuid: msg.uuid,
        type: "result",
        mime: format === "jpeg" ? "image/jpeg" : "image/png",
        image: buf.toString("base64"),
      });
    } catch (e) {
      process.send?.({
        uuid: msg.uuid,
        type: "error",
        message: (e as Error).message ?? String(e),
      });
    }
  });

  process.on("SIGINT", async () => {
    await browser.close().catch(() => {});
    process.exit(0);
  });

  // 通知父进程浏览器已就绪
  process.send?.({ type: "ready" });
}

main().catch((e) => {
  console.error("html 渲染进程启动失败:", e);
  process.exit(1);
});
