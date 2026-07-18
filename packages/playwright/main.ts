import type { BrowserContext, Page, Response } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { chromium } from "playwright-extra";
import { z } from "zod";
import stealth from "puppeteer-extra-plugin-stealth";
import PQueue from "p-queue";

chromium.use(stealth());

const PORT = 0; // 0 = 由系统自动分配端口，启动后通过 IPC 回传给父进程
const BASE_URL = "https://www.doubao.com/chat/";
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGES = 5;
const QUEUE_LIMIT = 10;
const GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

const NOVNC = process.env.NOVNC === "1"; // 设 NOVNC=1 启用 VNC 模式
const JPEG_QUALITY = Number(process.env.VIEW_QUALITY ?? 55);
const INJECT_NO_ANIM = process.env.VIEW_NO_ANIM !== "0";

// 注入 CSS 强杀所有动画/过渡（设 VIEW_NO_ANIM=0 可关）
const NO_ANIM_CSS = `(function(){
  const s = document.createElement('style');
  s.textContent = \`*, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }\`;
  (document.head || document.documentElement).appendChild(s);
})()`;

/**
 * 可选：如果在 Linux 上且未设置 DISPLAY 环境变量，自动启动 Xvfb
 */
async function maybeStartXvfb(): Promise<void> {
  if (!NOVNC || process.platform !== "linux") return;
  if (process.env.DISPLAY) return;
  if (existsSync("/tmp/.X99-lock")) {
    process.env.DISPLAY = ":99";
    return;
  }
  try {
    const child = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.env.DISPLAY = ":99";
    await new Promise((r) => setTimeout(r, 500));
    console.log("Xvfb 已启动在 :99");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.error("!! NOVNC=1 但找不到 Xvfb，请先 apt-get install xvfb");
    }
  }
}

/**
 * 关闭页面上可能出现的弹窗
 * 用 aria-label="关闭" 定位弹窗的关闭按钮；500ms 内找不到则直接返回
 * @param page 页面对象
 * @returns 是否成功关闭
 */
async function closePromptIfPresent(page: Page): Promise<boolean> {
  try {
    const closeBtn = page.locator('button[aria-label="关闭"]').first();
    await closeBtn.waitFor({ state: "visible", timeout: 500 });
    await closeBtn.click();
    console.log("已关闭弹窗");
    return true;
  } catch {
    return false;
  }
}

/**
 * 设置浏览器上下文和页面
 * @param headless 是否无头模式
 * @param clean 是否清除持久上下文
 * @returns 包含上下文和页面的对象
 */
async function setupBrowser(headless: boolean, clean: boolean) {
  const args = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];
  if (headless) args.push("--headless=new");

  const launchOpts = {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args,
  };

  let ctx: BrowserContext;
  if (clean) {
    const browser = await chromium.launch({ ...launchOpts, headless });
    ctx = await browser.newContext({ viewport: launchOpts.viewport });
  } else {
    ctx = await chromium.launchPersistentContext("data/.browser", launchOpts);
  }

  const pg: Page = ctx.pages()[0] ?? (await ctx.newPage());
  return { context: ctx, page: pg };
}

/**
 * 上传图片到页面
 * @param page 页面对象
 * @param file 图片文件对象
 */
async function uploadImage(page: Page, file: File): Promise<void> {
  await closePromptIfPresent(page);

  const addBtn = page.locator('button:has(svg path[d^="M12.0005"])').first();
  await addBtn.click();

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 5000 });
  await fileInput.setInputFiles({
    name: file.name,
    mimeType: file.type,
    buffer: Buffer.from(await file.bytes()),
  });

  await page.waitForTimeout(2000);
}

/**
 * 导航到页面并发送提示
 * @param page 页面对象
 * @param prompt 提示文本
 * @param images 图片文件对象数组
 */
async function navigateAndSendPrompt(page: Page, prompt: string, images?: File[]): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await closePromptIfPresent(page);

  try {
    await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 10_000, state: "visible" });
  } catch (e2) {
    console.error(`!! 找不到输入框。url=${page.url()} title=${await page.title()}`);
    console.error(
      "textarea 数量:",
      await page.locator("textarea").count(),
      "contenteditable 数量:",
      await page.locator("[contenteditable]").count(),
    );
    throw e2;
  }

  if (images?.length) {
    for (const img of images) {
      await uploadImage(page, img);
    }
  }

  const ta = page.locator('textarea, [contenteditable="true"]').first();
  await ta.click();
  await ta.fill(prompt);
  await page.waitForTimeout(500);
  await ta.press("Enter");
}

/**
 * 从事件对象中提取图片URL
 * @param ev 事件对象
 * @param urls 已找到的URL数组
 * @returns 找到的URL数组
 */
function collectUrls(ev: any, urls: string[]): string[] {
  const found: string[] = [];

  for (const op of ev.patch_op ?? []) {
    for (const block of op.patch_value?.content_block ?? []) {
      const imgBlock = block.content?.image_block;
      const u1 = imgBlock?.image_ori?.url ?? imgBlock?.image_thumb?.url;
      if (u1 && !urls.includes(u1)) found.push(u1);

      for (const c of block.content?.creation_block?.creations ?? []) {
        const img = c.image;
        const u = img?.image_ori?.url ?? img?.image_thumb?.url ?? img?.key;
        if (u && !urls.includes(u)) found.push(u);
      }
    }
  }

  for (const block of ev.message?.content_block ?? []) {
    const imgBlock = block.content?.image_block;
    const u = imgBlock?.image_ori?.url ?? imgBlock?.image_thumb?.url;
    if (u && !urls.includes(u)) found.push(u);
  }

  if (ev.content) {
    try {
      const c = typeof ev.content === "string" ? JSON.parse(ev.content) : ev.content;
      const imgBlock = c?.image_block;
      const u = imgBlock?.image_ori?.url ?? imgBlock?.image_thumb?.url;
      if (u && !urls.includes(u)) found.push(u);
    } catch {
      /* ignore parse errors */
    }
  }

  urls.push(...found);
  return found;
}

/**
 * 生成图片URL列表
 * @param page 页面对象
 * @param prompt 提示文本
 * @param images 图片文件对象数组
 * @returns 图片URL数组
 */
async function generateImages(page: Page, prompt: string, images?: File[]): Promise<string[]> {
  const urls: string[] = [];
  let done = false;

  const onResponse = async (res: Response) => {
    if (done || !res.url().includes("/chat/completion")) return;
    try {
      for (const line of (await res.text()).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "{}") continue;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        collectUrls(ev, urls);
      }
    } catch {
      /* ignore response body read errors */
    }
  };

  page.on("response", onResponse);
  try {
    await navigateAndSendPrompt(page, prompt, images);
    await closePromptIfPresent(page);

    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let checks = 0;
    while (Date.now() < deadline && urls.length === 0) {
      await page.waitForTimeout(2000);
      checks++;
      if (checks % 5 === 0) {
        console.log(`已等待 ${checks * 2} 秒，当前 URLs 数量:${urls.length}`);
      }
    }
  } finally {
    done = true;
    page.off("response", onResponse);
  }
  return urls;
}

/**
 * 删除当前对话
 * @param page 页面对象
 */
async function deleteCurrentConversation(page: Page): Promise<void> {
  await closePromptIfPresent(page);
  console.log("开始清理当前对话...");
  try {
    const active = page.locator('div[data-empty-conversation] a[aria-current="page"]').first();
    await active.waitFor({ state: "visible", timeout: 3000 });
    await active.hover();
    await page.waitForTimeout(300);
    // 点击菜单按钮
    await active.locator("button").first().click({ force: true });
    // 点击删除菜单项
    await page.getByRole("menuitem", { name: "删除" }).first().click();
    // 点击二次确认删除
    await page.getByRole("dialog").first().getByRole("button", { name: "删除" }).first().click();
  } catch (e) {
    console.warn("删除对话失败，但不影响图片获取", e);
  }
}

async function main(): Promise<void> {
  await maybeStartXvfb();

  const { context, page } = await setupBrowser(false, false);

  // 用 init_script 注入强杀动画 CSS，每次跳转/刷新都自动生效
  if (INJECT_NO_ANIM) {
    try {
      await context.addInitScript(NO_ANIM_CSS);
      console.log("已注入禁动画 CSS（VIEW_NO_ANIM=0 可关闭）");
    } catch (e) {
      console.warn(`注入禁动画 CSS 失败（忽略）: ${(e as Error).message ?? e}`);
    }
  }

  // NOVNC 模式下不最小化窗口，方便 VNC 看到完整浏览器界面
  if (!NOVNC) {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch (e) {
      console.warn(`CDP 最小化失败（忽略）: ${(e as Error).message ?? e}`);
    }
  }

  const queue = new PQueue({ concurrency: 1 });

  const fileSchema = z.instanceof(File).refine((file) => ALLOWED_IMAGE_TYPES.includes(file.type), {
    message: `不支持的图片类型，仅允许 ${ALLOWED_IMAGE_TYPES.join(", ")}`,
  });

  // hono/validator 已经把同名多文件合并成数组，这里只补"单值变数组"这一种情况
  const filesSchema = z.preprocess((v) => (v ? (Array.isArray(v) ? v : [v]) : v), z.array(fileSchema).max(MAX_IMAGES));

  const generateSchema = z.object({
    prompt: z.string().min(1),
    images: filesSchema.optional(),
  });

  const app = new Hono()
    .get("/health", (c) => c.json({ status: "ok" }))
    .get("/page/screenshot", async (c) => {
      const full = c.req.query("full") === "true";
      const buf = await page.screenshot({
        type: "jpeg",
        quality: JPEG_QUALITY,
        fullPage: full,
        animations: "disabled",
        caret: "hide",
      });
      return c.body(new Uint8Array(buf), 200, { "content-type": "image/jpeg" });
    })
    .post("/generate", zValidator("form", generateSchema), async (c) => {
      if (queue.size + queue.pending >= QUEUE_LIMIT) return c.json({ error: "Queue is full" }, 503);
      const body = c.req.valid("form");
      const urls = await queue.add(() => generateImages(page, `生成图片：${body.prompt}`, body.images));
      await deleteCurrentConversation(page);
      return c.json({ urls });
    });

  process.on("SIGINT", async () => {
    console.log("\n正在关闭...");
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    const mode = NOVNC ? "VNC 模式" : "本地模式";
    console.log(`🦊 Hono 运行中 (${mode}): http://${info.address}:${info.port}`);
    // 通过 IPC 把实际端口回传给父进程；独立运行时 process.send 为 undefined，安全跳过
    process.send?.({ type: "ready", port: info.port });
  });
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
