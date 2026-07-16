import type { LanguageModelUsage } from "ai";
import XMLBuilder from "fast-xml-builder";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";

import { logger } from "@/logger";

import type { OneBotMessageEvent, OneBotMessageSegment } from "@/onebot/websocket-client";
import { OneBotClient, type OneBotEventContext } from "@/onebot/onebot-client";
import { startBuiltinNapCat } from "@/napcat/loader";
import { db } from "@/database/db";
import { apply as applyMigrations } from "@/database/migration";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { imageToText } from "@/multimedia";
import { runReply } from "@/reply";
import { runPlanner } from "@/planner";
import { cache } from "@/utils/cache";
import { downloadToCache } from "@/utils/image-cache";
import { compressImage } from "@/utils/image-resize";
import { registerShutdownHook } from "@/utils/shutdown";
import { config, type Config } from "@/config";
import { runMain } from "./agent";
import { dispatchMessage } from "./dispatcher";

dayjs.locale("zh-cn");

/**
 * 检查ID是否在范围内
 * @param id 要检查的ID
 * @param scope 范围配置
 * @returns 是否在范围内
 */
function isIdInScope(id: string, scope: Config["napcat"]["groups"]): boolean {
  const isInList = scope.ids.includes(id);
  if (scope.mode === "whitelist") {
    // 白名单模式：只有在列表中的ID才允许
    return isInList;
  } else {
    // 黑名单模式：只有在列表中的ID才禁止
    return !isInList;
  }
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
  data: { userId: string; nickname: string; segments: UnifiedInboundMessage[] }; // userId 为用户短号 u1、u2…
}
export type UnifiedInboundMessage = UnifiedTextMessage | UnifiedAtMessage | UnifiedImageMessage | UnifiedReplyMessage;

export interface PendingMessage {
  userId: string; // 短号 u1、u2…，来自 user_alias
  unifiedMessages: UnifiedInboundMessage[];
  nickname: string;
  date: Date;
  isAt: boolean;
  isAdmin: boolean;
  evaluated?: boolean;
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
      if (inner.length === 0) continue;
      const nickname = await getNickname(result.userId);
      const alias = ensureUserAlias("onebot", String(result.userId), nickname);
      messages.push({ type: "reply", data: { userId: shortIdFor(alias.id), nickname, segments: inner } });
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

  const downloaded = await Promise.all(
    urls.map(async (url) => {
      try {
        const { virtualPath, realPath } = await downloadToCache(url);
        return { url, virtualPath, realPath };
      } catch (error) {
        logger.error({ url, error }, "下载失败");
        return null;
      }
    }),
  );

  const pathMap = new Map<string, { realPath: string; sourceUrls: string[] }>();
  for (const item of downloaded) {
    if (!item) continue;
    const group = pathMap.get(item.virtualPath);
    if (group) {
      group.sourceUrls.push(item.url);
    } else {
      pathMap.set(item.virtualPath, { realPath: item.realPath, sourceUrls: [item.url] });
    }
  }

  await Promise.all(
    Array.from(pathMap.entries()).map(async ([path, { realPath, sourceUrls }]) => {
      let description = await cache.get<string>(path);
      if (!description) {
        try {
          const blob = await compressImage(Bun.file(realPath));
          description = (await imageToText(blob)).trim();
          cache.set(path, description).catch((err) => {
            logger.error({ error: err }, "缓存图片描述失败");
          });
        } catch (error) {
          logger.error({ path, error }, "转述失败");
          description = "图片转述失败";
        }
      }
      for (const url of sourceUrls) {
        resultMap.set(url, { path, description });
      }
    }),
  );

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
          parts.push(`<reply user_id="${seg.data.userId}" nickname="${seg.data.nickname}">${inner}</reply>`);
        }
      }
    }
    return parts
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .join(" ");
  };

  for (const msg of batch) {
    const text = formatMessage(msg.unifiedMessages);
    let block = `<user_input user_id="${msg.userId}" date="${dayjs(msg.date).format("MM-DD dddd HH:mm")}" nickname="${msg.nickname}">\n${text}\n</user_input>`;
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
 * 创建一个任务调度器。
 * 只关心三件事：收集任务、收到 arm 信号时执行、对外提供队列快照。
 * 防抖、触发条件判定等业务逻辑全部由调用方负责。
 *
 * @param process - 批处理回调，接收一批任务与触发时保存的上下文
 * @param options.maxQueue - 队列最大长度，超容时丢弃最旧任务，默认 30
 */
function createScheduler<T, C>(process: (batch: T[], ctx: C) => Promise<void>, options: { maxQueue?: number } = {}) {
  const { maxQueue = 30 } = options;
  const queue: T[] = [];

  let wake: (() => void) | null = null;
  let armed = false;
  let currentCtx: C | null = null;

  /**
   * 主循环：未 armed 时挂起等待；收到 arm 后取出整批任务交给 process 处理。
   */
  async function run() {
    while (true) {
      if (!armed) {
        await new Promise<void>((r) => {
          wake = r;
        });
      }

      const batch = queue.splice(0);
      const ctx = currentCtx;

      armed = false;
      currentCtx = null;

      if (batch.length === 0 || !ctx) continue;

      try {
        await process(batch, ctx);
      } catch (error) {
        logger.error({ error }, "处理批次出错");
      }
    }
  }

  function enqueue(item: T, ctx: C) {
    while (queue.length >= maxQueue) {
      queue.shift();
    }
    queue.push(item);
  }

  /**
   * 触发执行：通知调度器消费当前队列中的全部消息。
   */
  function arm(ctx: C) {
    armed = true;
    currentCtx = ctx;
    if (wake) {
      wake();
      wake = null;
    }
  }

  /**
   * 返回当前队列的只读快照，供调用方异步判定是否满足触发条件。
   */
  function snapshot() {
    return [...queue];
  }

  return { enqueue, arm, snapshot, run };
}

/**
 * 创建一个绑定到指定会话的机器人实例。
 *
 * 机器人内部通过调度器收集并批处理待处理消息，每个批次会：
 * 1. 递归提取消息中的图片 URL（包括回复引用中的图片）
 * 2. 下载并处理图片资源
 * 3. 构建完整 prompt 并依次调用 planner 与 reply 流程
 * 4. 将回复文本通过 ctx.reply 逐段发送
 *
 * @param sessionId - 当前会话 ID
 * @returns 暴露的 enqueue 方法，用于将新消息加入调度队列
 */
function createBot(sessionId: string) {
  const log = logger.child({ sessionId });

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
    const prompt = buildPrompt(batch, imageMap).trim();
    log.info({ prompt }, "用户输入");

    const { plan, reasoning, submitReply } = await runPlanner(prompt, log);
    const { replyText } = await runReply(prompt, plan, reasoning, async (segments) => {
      for (const seg of segments) {
        await ctx.reply(seg);
        await Bun.sleep(500);
      }
    });
    await submitReply(replyText);
  }

  const scheduler = createScheduler(processBatch, { maxQueue: 30 });
  scheduler.run().catch((error) => log.error({ error }, "scheduler 运行失败"));

  const debounceMs = 1000;
  let lastMsgAt = Date.now();
  let dirty = false;
  let evaluating = false;
  let forceArm = false;

  async function evaluationLoop(ctx: OneBotEventContext<OneBotMessageEvent>) {
    if (evaluating) {
      dirty = true;
      return;
    }
    evaluating = true;

    try {
      while (true) {
        while (Date.now() - lastMsgAt < debounceMs) {
          await Bun.sleep(100);
        }

        if (forceArm) {
          forceArm = false;
          scheduler.arm(ctx);
          break;
        }

        const queueSnapshot = scheduler.snapshot();
        if (queueSnapshot.length === 0) break;

        const unprocessed = queueSnapshot.filter((msg) => !msg.evaluated);
        if (unprocessed.length >= 5) {
          for (const msg of unprocessed) {
            msg.evaluated = true;
          }

          log.info("触发判定输入");
          const shouldTrigger = await dispatchMessage(queueSnapshot);
          if (shouldTrigger) {
            scheduler.arm(ctx);
            break;
          }
        }

        if (dirty) {
          dirty = false;
          continue;
        }
        break;
      }
    } catch (err) {
      log.error({ error: err }, "触发判定失败");
    } finally {
      evaluating = false;
    }
  }

  return {
    enqueue: (message: PendingMessage, ctx: OneBotEventContext<OneBotMessageEvent>) => {
      message.evaluated = false;
      scheduler.enqueue(message, ctx);
      lastMsgAt = Date.now();
      dirty = true;

      if (message.isAt) forceArm = true;

      evaluationLoop(ctx).catch((err) => log.error({ error: err }, "dispatch 失败"));
    },
  };
}

async function handleCommand(
  rawText: string,
  ctx: OneBotEventContext<OneBotMessageEvent>,
  isAdmin: boolean,
  sessionId: string,
): Promise<boolean> {
  if (rawText === "/ping" && isAdmin) {
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

  // 根据配置选择启动方式
  let wsUrl: string;
  let accessToken: string;

  if (config.napcat.qq_id) {
    const result = await startBuiltinNapCat(config.napcat.qq_id);
    wsUrl = result.wsUrl;
    accessToken = result.accessToken;
    registerShutdownHook("NapCat", () => result.stop());
  } else {
    wsUrl = config.napcat.ws_url!;
    accessToken = config.napcat.token ?? "";
    logger.info({ wsUrl }, "使用外置 NapCat");
  }

  // 创建 OneBot 客户端并连接
  const bot = new OneBotClient({
    url: wsUrl,
    accessToken,
    reconnect: true,
  });

  await bot.connect();

  const botMap = new Map<string, ReturnType<typeof createBot>>();
  const user = await bot.getLoginInfo();
  const selfId = String(user.user_id);

  logger.info({ selfId: String(user.user_id), nickname: user.nickname }, "Bot 已连接并运行");

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

    let isAt = false;
    if (event.message_type === "group") {
      if (!isIdInScope(String(event.group_id), config.napcat.groups)) {
        return;
      }
      if (!isIdInScope(String(event.user_id), config.napcat.group_members)) {
        return;
      }
      isAt = segments.some((seg) => seg.type === "at" && seg.data.qq === selfId);
    } else if (event.message_type === "private") {
      if (!isIdInScope(String(event.user_id), config.napcat.private_chats)) {
        return;
      }
      isAt = true;
    } else {
      return;
    }

    const isAdmin = event.sender.user_id === 2870245624;
    // 把发送者写进用户映射表（首次见到时建立短号），过滤之后做，避免无关用户也入缓存
    const alias = ensureUserAlias("onebot", String(event.user_id), event.sender.nickname);
    const rawText = segments
      .filter((seg) => seg.type === "text")
      .map((seg) => seg.data.text)
      .join(" ")
      .trim();

    const sessionId = event.message_type === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;

    if (isAt) {
      const isCommandHandled = await handleCommand(rawText, ctx, isAdmin, sessionId);
      if (isCommandHandled) return;
    }

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
          ensureUserAlias("onebot", String(user_id));
          return { userId: user_id, message: message };
        },
      );

      if (unified.length === 0) {
        logger.debug({ sessionId, messageType: event.message_type }, "没有可解析的消息内容，跳过当前输入");
        return;
      }

      /**
       * 未来：
       * 需要设计一种方式，使用数据库存储队列而不是内存，保证重启后仍然可以保留队列。
       * 这个方案需要保持较低的侵入性，我希望使用上能和目前的cache数组类似。
       * 目前我能想到的做法就是学习我的parseOneBotMessage实现，规划器接受一个或多个函数，无需关心里面的具体实现。
       *
       * 计划：
       * 依旧使用内存数组快速完成原型开发，之后首先将内存数组改修改为函数接口模式，再考虑如何接入sqlite模式。
       */
      const message = {
        userId: shortIdFor(alias.id),
        unifiedMessages: unified,
        nickname: event.sender.nickname,
        date: new Date(event.time * 1000),
        isAt,
        isAdmin,
      };
      getBot(sessionId).enqueue(message, ctx);
    } catch (error) {
      logger.error({ sessionId, error }, "消息解析或入队失败");
    }
  });
}
