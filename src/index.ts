import { generateText, type LanguageModel, type LanguageModelUsage, type ModelMessage } from "ai";
import type { OneBotMessageEvent, OneBotMessageSegment } from "./onebot/websocket-client";
import { OneBotClient, type OneBotEventContext } from "./onebot/onebot-client";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { extractVideoId, resolveShortUrl, getVideoInfo, downloadBilibiliVideo } from "./bilibili";

import { download } from "./utils/blob";
import { saveBufferToCache } from "./utils/image-cache";
import { cache } from "./utils/cache";
import { env } from "node:process";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { imageToText } from "./multimedia";
import { parseMarkdown, type MessagePart } from "./images";
import { splitMessage } from "./utils/message-splitter";
import tools from "./tool";

import XMLBuilder from "fast-xml-builder";
import systemPrompt from "../prompts/贤惠幼妻仙狐小姐.md";
import summaryPrompt from "../prompts/summary.md";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";

dayjs.locale("zh-cn");

interface UnifiedTextMessage {
  type: "text";
  text: string;
}
interface UnifiedAtMessage {
  type: "at";
  data: { id: string; nickname: string };
}
interface UnifiedImageMessage {
  type: "image";
  data: { url: string };
}
interface UnifiedReplyMessage {
  type: "reply";
  data: { id: string; nickname: string; segments: UnifiedInboundMessage[] };
}
type UnifiedInboundMessage = UnifiedTextMessage | UnifiedAtMessage | UnifiedImageMessage | UnifiedReplyMessage;

interface PendingMessage {
  unifiedMessages: UnifiedInboundMessage[];
  nickname: string;
  date: Date;
  isMaster: boolean;
}

const bot = new OneBotClient({
  url: "ws://127.0.0.1:3001",
  accessToken: "your_token",
  reconnect: true,
});

const provider = createOpenAICompatible({
  name: "new-api",
  apiKey: env.OPENAI_API_KEY!,
  baseURL: env.OPENAI_API_BASE!,
});
const model = provider("deepseek-v4-flash-free");

/**
 * 解析OneBot消息段落为统一格式
 * @param segments OneBot消息段落
 * @param getNickname 获取用户昵称的函数
 * @param getMessage 获取回复消息的函数
 * @returns 解析后的统一格式消息段落
 */
async function parseOneBotMessage(
  segments: OneBotMessageSegment[],
  getNickname: (qq: number) => Promise<string>,
  getMessage: (id: number) => Promise<{ userId: number; message: OneBotMessageSegment[] } | null>,
) {
  const messages: UnifiedInboundMessage[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      messages.push({ type: "text", text: seg.data.text });
    } else if (seg.type === "at") {
      const nickname = await getNickname(Number(seg.data.qq));
      messages.push({ type: "at", data: { id: seg.data.qq, nickname: nickname ?? " " } });
    } else if (seg.type === "image") {
      messages.push({ type: "image", data: { url: seg.data.url } });
    } else if (seg.type === "reply") {
      const result = await getMessage(Number(seg.data.id));
      if (!result) continue;
      let inner = await parseOneBotMessage(result.message, getNickname, () => Promise.resolve(null));
      let nickname = await getNickname(result.userId);
      messages.push({ type: "reply", data: { id: seg.data.id, nickname, segments: inner } });
    }
  }
  return messages;
}

/**
 * 处理图片资产，包括下载、转述和缓存
 * @param urls 图片URL列表
 * @returns 图片路径和描述的映射
 */
async function processImageAssets(urls: string[]) {
  const resultMap = new Map<string, { path: string; description: string }>();
  if (urls.length === 0) return resultMap;

  const downloadTasks = urls.map(async (url) => {
    try {
      const blob = await download(url);
      const buffer = Buffer.from(await blob.bytes());
      const path = await saveBufferToCache(buffer, blob.type);
      return { url, path, success: true as const };
    } catch (error) {
      console.error(`下载图片失败: ${url}`, error);
      return { url, path: "", success: false as const };
    }
  });
  const downloaded = await Promise.all(downloadTasks);

  const uniquePaths = new Map<string, string>();
  for (const item of downloaded) {
    if (item.success && !uniquePaths.has(item.path)) {
      uniquePaths.set(item.path, item.url);
    }
  }

  const descriptionTasks = Array.from(uniquePaths.entries()).map(async ([path, url]) => {
    try {
      const cached = await cache.get<string>(path);
      if (cached) return { path, description: cached };
      const description = await imageToText(url);
      await cache.set(path, description);
      return { path, description };
    } catch (error) {
      console.error(`图片转述失败: ${path}`, error);
      return { path, description: "[图片转述失败]" };
    }
  });
  const descriptions = await Promise.all(descriptionTasks);
  const pathToDesc = new Map(descriptions.map((d) => [d.path, d.description]));

  for (const item of downloaded) {
    if (item.success) {
      resultMap.set(item.url, {
        path: item.path,
        description: pathToDesc.get(item.path) || "[未知图片]",
      });
    } else {
      resultMap.set(item.url, { path: "", description: "[图片加载失败]" });
    }
  }
  return resultMap;
}

function formatMessageSegments(
  segments: UnifiedInboundMessage[],
  imageMap: Map<string, { path: string; description: string }>,
) {
  const parts: string[] = [];
  const images: { "@_path": string; "#text": string }[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      parts.push(seg.text);
    } else if (seg.type === "at") {
      if (seg.data.nickname) {
        parts.push(`@${seg.data.nickname}`);
      }
    } else if (seg.type === "image") {
      const img = imageMap.get(seg.data.url);
      if (img && img.path) {
        parts.push(`\`${img.path}\``);
        images.push({ "@_path": img.path, "#text": img.description });
      } else {
        parts.push("[图片]");
      }
    } else if (seg.type === "reply") {
      const inner = formatMessageSegments(seg.data.segments, imageMap);
      images.push(...inner.images);
      if (inner.text.trim()) {
        parts.push(`<reply nickname="${seg.data.nickname}">${inner.text.trim()}</reply>`);
      }
    }
  }
  return { text: parts.join("  "), images };
}

function buildPrompt(batch: PendingMessage[], imageMap: Map<string, { path: string; description: string }>) {
  const promptParts: string[] = [];
  const allImages: { "@_path": string; "#text": string }[] = [];

  for (const msg of batch) {
    const { text, images } = formatMessageSegments(msg.unifiedMessages, imageMap);
    allImages.push(...images);

    let block = `<user_input date="${dayjs(msg.date).format("MM-DD dddd HH:mm")}" nickname="${msg.nickname}">\n${text}\n</user_input>`;
    if (!msg.isMaster) block = "收到一条路人的消息\n" + block;
    promptParts.push(block);
  }

  const uniqueImagesMap = new Map<string, { "@_path": string; "#text": string }>();
  for (const img of allImages) uniqueImagesMap.set(img["@_path"], img);
  const uniqueImages = Array.from(uniqueImagesMap.values());

  let finalPrompt = promptParts.join("\n\n");
  const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
  if (uniqueImages.length > 0) {
    const reminder = builder
      .build({
        system_reminder: {
          "#text": "下面是对话中对应图像的文字描述。\n",
          image: uniqueImages,
        },
      })
      .trim();
    finalPrompt = `${reminder}\n\n${finalPrompt}`;
  }
  return finalPrompt;
}

async function loadChatHistory(name: string): Promise<ModelMessage[]> {
  try {
    const history = await readFile(resolve(".cache", `${name}.json`), "utf8");
    return JSON.parse(history);
  } catch {
    return [];
  }
}

async function saveChatHistory(name: string, history: ModelMessage[]) {
  try {
    await mkdir(resolve(".cache"), { recursive: true });
    await writeFile(resolve(".cache", `${name}.json`), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error(`保存历史记录失败: ${error}`);
  }
}

async function executeAgent(prompt: string, onReply: (chunk: string) => Promise<void>) {
  console.log("prompt: ", prompt);
  const history = await loadChatHistory("chat");

  let messages: ModelMessage[] = [...history, { role: "user", content: prompt }];
  let usage: LanguageModelUsage | undefined;

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
    });

    if (result.reasoning) console.log("内部思考: ", result.reasoning);
    if (result.text) console.log("助手响应: ", result.text);

    if (result.text) {
      await onReply(result.text);
    }
    usage = result.usage;
    messages = [...messages, ...result.response.messages];

    if (result.toolCalls.length === 0) break;
  }

  await saveChatHistory("chat", messages);
  return { messages, usage };
}

// ── 消息调度器（拉模型 + debounce，与业务逻辑隔离） ───

function extractImageUrls(segments: UnifiedInboundMessage[], urls: Set<string>) {
  for (const seg of segments) {
    if (seg.type === "image") urls.add(seg.data.url);
    else if (seg.type === "reply") extractImageUrls(seg.data.segments, urls);
  }
}

/**
 * 创建一个消息调度器，负责攒批、debounce 和唤醒，不关心消息体结构。
 * @param process 处理函数，接收一批消息和对应的上下文
 * @param debounceMs 静默期时长（毫秒），默认 1000
 */
function createScheduler<T, C>(process: (batch: T[], ctx: C) => Promise<void>, debounceMs = 1000) {
  const cache: T[] = [];
  let wake: (() => void) | null = null;
  let lastMsgAt = 0;
  let currentCtx: C | null = null;

  function enqueue(item: T, ctx: C) {
    if (!currentCtx) currentCtx = ctx;
    cache.push(item);
    lastMsgAt = Date.now();
    if (wake) {
      wake();
      wake = null;
    }
  }

  async function run() {
    while (true) {
      if (cache.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
      }
      while (Date.now() - lastMsgAt < debounceMs) {
        await Bun.sleep(100);
      }
      const batch = cache.splice(0);
      const ctx = currentCtx;
      currentCtx = null;
      if (batch.length === 0 || !ctx) continue;
      try {
        await process(batch, ctx);
      } catch (error) {
        console.error("处理批次出错:", error);
      }
    }
  }

  return { enqueue, run };
}

function createBot(sessionId: string) {
  async function processBatch(batch: PendingMessage[], ctx: OneBotEventContext<OneBotMessageEvent>) {
    const urls = new Set<string>();
    for (const msg of batch) {
      extractImageUrls(msg.unifiedMessages, urls);
    }
    const imageMap = await processImageAssets(Array.from(urls));
    const prompt = buildPrompt(batch, imageMap);
    await executeAgent(prompt, async (chunk) => {
      const parts = await parseMarkdown(chunk);
      for (const part of parts) {
        if (typeof part === "string") {
          for (const seg of splitMessage(part)) {
            if (!seg.trim()) continue;
            await ctx.reply(seg);
            await Bun.sleep(500);
          }
        } else {
          await ctx.reply(part);
          await Bun.sleep(1000);
        }
      }
    });
  }

  const scheduler = createScheduler(processBatch);
  scheduler.run().catch(console.error);

  return { enqueue: scheduler.enqueue };
}

async function handleCommand(
  rawText: string,
  ctx: OneBotEventContext<OneBotMessageEvent>,
  isMaster: boolean,
  sessionId: string,
): Promise<boolean> {
  if (rawText === "/ping" && isMaster) {
    const event = ctx.event as OneBotMessageEvent;
    const latency = Date.now() - event.time * 1000;
    await ctx.reply(`pong (${latency}ms)`);
    return true;
  }

  if (rawText === "/usage") {
    const u = await cache.get<LanguageModelUsage>("usage");
    const fmt = (v: number | undefined) => (v ?? 0).toLocaleString();
    await ctx.reply(
      [
        `┌ 输入 ${fmt(u?.inputTokens)}`,
        `│  ├ 缓存读 ${fmt(u?.inputTokenDetails?.cacheReadTokens)}`,
        `│  └ 缓存写 ${fmt(u?.inputTokenDetails?.cacheWriteTokens)}`,
        `├ 输出 ${fmt(u?.outputTokens)}`,
        `│  ├ 推理 ${fmt(u?.outputTokenDetails?.reasoningTokens)}`,
        `│  └ 正文 ${fmt(u?.outputTokenDetails?.textTokens)}`,
        `└ 总计 ${fmt(u?.totalTokens)}`,
      ].join("\n"),
    );
    return true;
  }

  const biliMatch = rawText.match(/^\/bili\s+(.+)$/);
  if (biliMatch && biliMatch[1]) {
    await handleBiliLink(biliMatch[1].trim(), ctx);
    return true;
  }

  return false;
}

async function handleBiliLink(input: string, ctx: OneBotEventContext<OneBotMessageEvent>) {
  try {
    let resolvedInput = input;
    if (input.includes("b23.tv") || input.includes("b23.wtf")) {
      const realUrl = await resolveShortUrl(input);
      if (!realUrl) {
        await ctx.reply("无法解析b23.tv短链接");
        return;
      }
      resolvedInput = realUrl;
    }

    const videoId = extractVideoId(resolvedInput);
    if (!videoId) {
      await ctx.reply("无法识别B站视频，请提供有效的BV号、AV号或B站视频链接");
      return;
    }

    const info = await getVideoInfo(videoId.bvid);
    const mins = Math.floor(info.duration / 60);
    const secs = info.duration % 60;
    await ctx.reply([
      { type: "image", data: { file: info.pic, url: info.pic } },
      {
        type: "text",
        data: {
          text: [
            info.title,
            `UP主: ${info.owner.name}`,
            `时长: ${mins}:${secs.toString().padStart(2, "0")}`,
            `分P: ${info.pages.length}`,
            `正在下载...`,
          ].join("\n"),
        },
      },
    ]);

    const cacheDir = resolve(".cache", "bilibili");
    await mkdir(cacheDir, { recursive: true });
    const outputPath = resolve(cacheDir, `${videoId.bvid}.mp4`);

    if (info.pages.length === 0) {
      await ctx.reply("该视频没有可下载的分P");
      return;
    }

    const exists = await stat(outputPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await downloadBilibiliVideo(videoId.bvid, info.pages[0]!.cid, outputPath);
    }

    await ctx.reply({ type: "video", data: { file: outputPath, url: "", thumb: info.pic } });
  } catch (error: unknown) {
    console.error("B站视频处理失败:", error);
    await ctx.reply("B站视频处理失败");
  }
}

async function main() {
  let selfId: string | undefined = undefined;
  const botMap = new Map<string, ReturnType<typeof createBot>>();

  function getBot(sessionId: string) {
    let bot = botMap.get(sessionId);
    if (!bot) {
      bot = createBot(sessionId);
      botMap.set(sessionId, bot);
    }
    return bot;
  }

  bot.onMessage(async (event, ctx) => {
    const segments = event.message;
    if (event.message_type === "group") {
      if (![761178785, 976782057].includes(event.group_id)) {
        return;
      }
      const isAtBot = segments.some((seg) => seg.type === "at" && seg.data.qq === selfId);
      if (!isAtBot) {
        return;
      }
    } else if (event.message_type === "private") {
      if (event.user_id !== 2870245624) {
        return;
      }
    } else {
      return;
    }

    const isMaster = event.sender.user_id === 2870245624;
    const rawText = segments
      .filter((seg) => seg.type === "text")
      .map((seg) => seg.data.text)
      .join(" ")
      .trim();

    const sessionId = event.message_type === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;

    const isCommandHandled = await handleCommand(rawText, ctx, isMaster, sessionId);
    if (isCommandHandled) return;

    try {
      const unified = await parseOneBotMessage(
        segments,
        async (qq) => {
          if (event.message_type === "group") {
            const { nickname } = await ctx.client.getGroupMemberInfo(Number(event.group_id), qq);
            return nickname;
          }
          const { nickname } = await ctx.client.getStrangerInfo(qq);
          return nickname;
        },
        async (id) => {
          const { user_id, message } = await ctx.client.getMessage(Number(id));
          return { userId: user_id, message: message };
        },
      );

      getBot(sessionId).enqueue(
        {
          unifiedMessages: unified,
          nickname: event.sender.nickname,
          date: new Date(event.time * 1000),
          isMaster,
        },
        ctx,
      );
    } catch (error) {
      console.error("消息解析或入队失败:", error);
    }
  });

  await bot.connect();
  const { user_id, nickname } = await bot.getLoginInfo();
  selfId = String(user_id);
  console.log(`Bot 已连接并运行，ID: ${user_id}，昵称: ${nickname}`);
}

main().catch(console.error);
