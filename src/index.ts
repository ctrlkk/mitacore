import { createServer } from "node:net";
import { resolve } from "node:path";
import { cwd } from "node:process";

import type { LanguageModelUsage } from "ai";
import XMLBuilder from "fast-xml-builder";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";

import type { OneBotMessageEvent, OneBotMessageSegment } from "./onebot/websocket-client";
import { OneBotClient, type OneBotEventContext } from "./onebot/onebot-client";
import { launchNapCat, type NapCatConfig } from "./napcat/loader";
import { db } from "./database/db";
import { apply as applyMigrations } from "./database/migration";
import { ensureUserAlias } from "./database/user-alias";
import { imageToText } from "./multimedia";
import { runExecutor } from "./executor";
import { runPlanner } from "./planner";
import { blobToDataURL, download } from "./utils/blob";
import { cache } from "./utils/cache";
import { saveBufferToCache } from "./utils/image-cache";

dayjs.locale("zh-cn");

function acquireEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

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
  // 下载图片
  const downloaded = await Promise.all(
    urls.map(async (url) => {
      try {
        const blob = await download(url);
        const buffer = Buffer.from(await blob.bytes());
        const path = await saveBufferToCache(buffer, blob.type);
        return { url, blob, path };
      } catch (error) {
        console.error(`下载图片失败: ${url}`, error);
        return null;
      }
    }),
  );
  // 过滤并去重
  const uniquePaths = new Map(downloaded.filter((item) => item !== null).map((item) => [item.path, item.blob]));
  // 转述
  const descriptions = await Promise.all(
    Array.from(uniquePaths.entries()).map(async ([path, blob]) => {
      try {
        const cached = await cache.get<string>(path);
        if (cached) return { path, description: cached };
        const description = await imageToText(await blobToDataURL(blob));
        await cache.set(path, description);
        return { path, description };
      } catch (error) {
        console.error(`图片转述失败: ${path}`, error);
        return { path, description: "图片转述失败" };
      }
    }),
  );
  // 映射
  const pathToDesc = new Map(descriptions.map((d) => [d.path, d.description]));
  downloaded
    .filter((item) => item !== null)
    .forEach((item) => {
      resultMap.set(item.url, {
        path: item.path,
        description: pathToDesc.get(item.path) || "未知图片",
      });
    });

  return resultMap;
}

function buildPrompt(batch: PendingMessage[], imageMap: Map<string, { path: string; description: string }>) {
  const promptParts: string[] = [];

  const formatMessage = (segments: UnifiedInboundMessage[]) => {
    const parts: string[] = [];
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
        } else {
          parts.push("[图片]");
        }
      } else if (seg.type === "reply") {
        const inner = formatMessage(seg.data.segments);
        if (inner) {
          parts.push(`<reply nickname="${seg.data.nickname}">${inner}</reply>`);
        }
      }
    }
    return parts.join("  ").trim();
  };

  for (const msg of batch) {
    const text = formatMessage(msg.unifiedMessages);
    let block = `<user_input date="${dayjs(msg.date).format("MM-DD dddd HH:mm")}" nickname="${msg.nickname}">\n${text}\n</user_input>`;
    if (!msg.isMaster) block = "收到一条路人的消息\n" + block;
    promptParts.push(block);
  }

  let finalPrompt = promptParts.join("\n\n");

  // 去重并格式化图片描述
  const uniqueImages = Array.from(new Map(imageMap.values().map((img) => [img.path, img])).values());
  if (uniqueImages.length > 0) {
    const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
    const reminder = builder
      .build({
        system_reminder: {
          image: uniqueImages,
        },
      })
      .trim();
    finalPrompt = `${reminder}\n\n${finalPrompt}`;
  }
  return finalPrompt;
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

    const extractImage = (segments: UnifiedInboundMessage[]) => {
      for (const seg of segments) {
        if (seg.type === "image") urls.add(seg.data.url);
        else if (seg.type === "reply") extractImage(seg.data.segments);
      }
    };
    for (const msg of batch) {
      extractImage(msg.unifiedMessages);
    }
    const imageMap = await processImageAssets(Array.from(urls));
    const prompt = buildPrompt(batch, imageMap);

    const { plan, submitReply } = await runPlanner(prompt);
    const { replyText } = await runExecutor(prompt, plan, async (segments) => {
      for (const seg of segments) {
        await ctx.reply(seg);
        await Bun.sleep(500);
      }
    });
    await submitReply(replyText);
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

  return false;
}

if (import.meta.main) {
  // 先跑数据库迁移：空库走 bootstrap，已 bootstrap 的库只跑新增迁移
  await applyMigrations(db);

  // NapCat 配置
  const napcatConfig: NapCatConfig = {
    qqId: "2790285434",
    napcatDir: resolve(cwd(), "data", "runtime", "napcat"),
    qqPath: "",
  };

  console.log("启动 NapCat...");
  const napcat = await launchNapCat(napcatConfig);
  const api = await napcat.waitForWebUI();
  console.log(`NapCat WebUI 端口: ${napcat.webuiPort}`);

  const version = await api.getNapCatVersion();
  console.log(`NapCat 版本: ${version}`);

  await napcat.waitForReady();
  console.log("NapCat 协议适配器已就绪");

  const isLoggedIn = await api.checkLoginStatus();
  console.log(`QQ 登录状态: ${isLoggedIn ? "已登录" : "未登录"}`);

  // 获取临时端口用于 WebSocket 服务器
  const wsPort = await acquireEphemeralPort();

  // 推送 OB11 配置
  await api.setOB11Config({
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
  });
  console.log("OneBot 配置已推送");

  // 创建 OneBot 客户端并连接
  const bot = new OneBotClient({
    url: `ws://127.0.0.1:${wsPort}`,
    accessToken: "",
    reconnect: true,
  });

  // 捕获暂停信号，在程序暂停时关闭 NapCat
  process.on("SIGINT", async () => {
    console.log("\n接收到中断信号，正在关闭 NapCat…");
    await napcat.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\n接收到终止信号，正在关闭 NapCat…");
    await napcat.stop();
    process.exit(0);
  });

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
    // 把发送者写进用户映射表（首次见到时建立短号），过滤之后做，避免无关用户也入缓存
    ensureUserAlias("onebot", String(event.user_id), event.sender.nickname);
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
            ensureUserAlias("onebot", String(qq), nickname);
            return nickname;
          }
          const { nickname } = await ctx.client.getStrangerInfo(qq);
          ensureUserAlias("onebot", String(qq), nickname);
          return nickname;
        },
        async (id) => {
          const { user_id, message } = await ctx.client.getMessage(Number(id));
          ensureUserAlias("onebot", String(user_id), event.sender.nickname);
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
