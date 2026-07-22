import type { LanguageModelUsage } from "ai";
import XMLBuilder from "fast-xml-builder";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";

import { logger } from "@/logger";

import type { OneBotMessageEvent, OneBotMessageSegment } from "@/onebot/websocket-client";
import { OneBotClient, type OneBotEventContext } from "@/onebot/onebot-client";
import { startBuiltinNapCat } from "@/napcat/loader";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { imageToText, videoToText } from "@/multimedia";
import { runReply } from "@/reply";
import { runPlanner } from "@/planner";
import { cache } from "@/utils/cache";
import { downloadToCache } from "@/utils/image-cache";
import { compressImage } from "@/utils/image-resize";
import { compressVideo } from "@/utils/video-resize";
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
interface UnifiedVideoMessage {
  type: "video";
  data: { url: string };
}
interface UnifiedReplyMessage {
  type: "reply";
  data: { userId: string; nickname: string; segments: UnifiedInboundMessage[] }; // userId 为用户短号 u1、u2…
}
export type UnifiedInboundMessage =
  | UnifiedTextMessage
  | UnifiedAtMessage
  | UnifiedImageMessage
  | UnifiedVideoMessage
  | UnifiedReplyMessage;

export type MediaKind = "image" | "video";

export type MediaMap = Map<
  string,
  {
    kind: MediaKind;
    path: string;
    description: string;
  }
>;

export type ImageMap = Map<string, { path: string; description: string }>;

export interface PendingMessage {
  userId: string; // 短号 u1、u2…，来自 user_alias
  unifiedMessages: UnifiedInboundMessage[];
  nickname: string;
  date: Date;
  isAt: boolean;
  /**
   * 标记一条消息是否已被 evaluationLoop 的触发判定逻辑"检查过"。
   */
  evaluated?: boolean;
  /**
   * 资源准备 Promise，在入队时立即启动下载与转述；
   * 不阻塞入队，对同一 URL 仅下载一次，对同一 path 仅转述一次。
   */
  resourcesPromise?: Promise<MediaMap>;
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
      if (Number(seg.data.file_size) < 5 * 1024 * 1024) {
        messages.push({ type: "image", data: { url: seg.data.url } });
      } else {
        logger.info({ url: seg.data.url }, "忽略图片，大小超过5MB");
      }
    } else if (seg.type === "video") {
      if (Number(seg.data.file_size) < 20 * 1024 * 1024) {
        messages.push({ type: "video", data: { url: seg.data.url! } });
      } else {
        logger.info({ url: seg.data.url }, "忽略视频，大小超过20MB");
      }
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

type MediaResource = {
  url: string;
  kind: MediaKind;
};

/**
 * 创建媒体资源处理器。
 * 内部维护下载与转述的去重缓存，确保并发安全。
 *
 * 注意：
 * - singleflight 只复用"下载结果"或"转述结果"
 * - 不把当前 process 的 resultMap 写入逻辑放进 singleflight 内部，
 *   否则并发复用 Promise 时，其他调用方的 sourceUrls 不会被写入自己的 resultMap
 */
function createMediaProcessor() {
  const pendingDownloads = new Map<string, Promise<{ virtualPath: string; realPath: string } | null>>();

  const pendingDescriptions = new Map<string, Promise<string>>();

  async function singleFlight<K, V>(map: Map<K, Promise<V>>, key: K, fn: () => Promise<V>): Promise<V> {
    const existing = map.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => map.delete(key));
    map.set(key, promise);
    return promise;
  }

  async function process(resources: MediaResource[]): Promise<MediaMap> {
    const resultMap: MediaMap = new Map();
    if (resources.length === 0) return resultMap;

    // 并发下载（单飞去重）
    // 这里按 kind:url 去重，避免同一个 URL 被图片和视频以不同限制处理时互相干扰。
    const downloaded = await Promise.all(
      resources.map(({ url, kind }) =>
        singleFlight(pendingDownloads, `${kind}:${url}`, async () => {
          try {
            if (kind === "image") {
              return await downloadToCache(url, { limit: 5 * 1024 * 1024 });
            } else if (kind === "video") {
              return await downloadToCache(url, { limit: 20 * 1024 * 1024 });
            }
          } catch (error) {
            logger.error({ url, kind, error }, "下载失败");
            return null;
          }
        }).then((res) => (res ? { url, kind, ...res } : null)),
      ),
    );

    // 按资源类型 + 物理路径归类
    const pathMap = new Map<
      string,
      {
        kind: MediaKind;
        virtualPath: string;
        realPath: string;
        sourceUrls: string[];
      }
    >();

    for (const item of downloaded) {
      if (!item) continue;

      const key = `${item.kind}:${item.virtualPath}`;
      const group = pathMap.get(key);

      if (group) {
        group.sourceUrls.push(item.url);
        continue;
      }

      pathMap.set(key, {
        kind: item.kind,
        virtualPath: item.virtualPath,
        realPath: item.realPath,
        sourceUrls: [item.url],
      });
    }

    // 并发转述（单飞去重）
    await Promise.all(
      Array.from(pathMap.values()).map(async (item) => {
        const cacheKey = item.virtualPath;

        const description = await singleFlight(pendingDescriptions, cacheKey, async () => {
          const cached = await cache.get<string>(cacheKey);
          if (cached) return cached;

          try {
            let result: string;

            if (item.kind === "image") {
              const blob = await compressImage(Bun.file(item.realPath));
              result = (await imageToText(blob)).trim();
            } else {
              const blob = await compressVideo(Bun.file(item.realPath));
              result = (await videoToText(blob)).trim();
            }

            await cache.set(cacheKey, result).catch((error) => logger.error({ error }, "缓存资源描述失败"));

            return result;
          } catch (error) {
            logger.error({ path: item.virtualPath, kind: item.kind, error }, "转述失败");
            return item.kind === "image" ? "图片转述失败" : "视频转述失败";
          }
        });

        for (const url of item.sourceUrls) {
          resultMap.set(url, {
            kind: item.kind,
            path: item.virtualPath,
            description,
          });
        }
      }),
    );

    return resultMap;
  }

  return process;
}

const processMediaAssets = createMediaProcessor();

function buildPrompt(batch: PendingMessage[], mediaMap: MediaMap) {
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
      } else if (seg.type === "image" || seg.type === "video") {
        const media = mediaMap.get(seg.data.url);

        if (media?.path) {
          parts.push(`\`${media.path}\``);
        } else {
          parts.push(seg.type === "image" ? "[图片]" : "[视频]");
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
    const block = `<user_input user_id="${msg.userId}" date="${dayjs(msg.date).format("MM-DD dddd HH:mm")}" nickname="${msg.nickname}">\n${text}\n</user_input>`;
    promptParts.push(block);
  }

  let finalPrompt = promptParts.join("\n\n");

  // 去重并格式化媒体描述
  const uniqueMedia = Array.from(
    new Map(mediaMap.values().map((media) => [`${media.kind}:${media.path}`, media])).values(),
  );

  const images = uniqueMedia
    .filter((media) => media.kind === "image")
    .map(({ path, description }) => ({ path, description }));

  const videos = uniqueMedia
    .filter((media) => media.kind === "video")
    .map(({ path, description }) => ({ path, description }));

  const reminder: {
    image?: Array<{ path: string; description: string }>;
    video?: Array<{ path: string; description: string }>;
  } = {};

  if (images.length > 0) reminder.image = images;
  if (videos.length > 0) reminder.video = videos;

  if (images.length > 0 || videos.length > 0) {
    const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
    const reminderText = builder
      .build({
        system_reminder: reminder,
      })
      .trim();

    finalPrompt = `${reminderText}\n\n${finalPrompt}`;
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
    const mediaMaps = await Promise.all(batch.map((m) => m.resourcesPromise!));
    const mediaMap: MediaMap = new Map();
    for (const map of mediaMaps) {
      for (const [url, info] of map) {
        mediaMap.set(url, info);
      }
    }
    const prompt = buildPrompt(batch, mediaMap).trim();
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

  async function evaluationLoop(ctx: OneBotEventContext<OneBotMessageEvent>) {
    if (evaluating) {
      dirty = true;
      return;
    }
    evaluating = true;

    try {
      while (true) {
        // 等待用户停止输入 1s
        while (Date.now() - lastMsgAt < debounceMs) {
          await Bun.sleep(100);
        }

        const queueSnapshot = scheduler.snapshot();
        const unprocessed = queueSnapshot.filter((m) => !m.evaluated);

        if (unprocessed.length === 0) {
          if (dirty) {
            dirty = false;
            continue;
          }
          break;
        }

        // 检查是否包含 AT 或私聊消息
        const hasForceTrigger = unprocessed.some((m) => m.isAt);

        if (!hasForceTrigger) {
          // 群聊普通消息模式（主动插话逻辑）
          // 必须攒够数量，且没有新消息到来，才进行后续处理，否则一直等待
          if (unprocessed.length < 5) {
            // 如果没有新消息到来，退出循环等待新消息
            if (!dirty) break;
            // 有新消息，重置 dirty 继续循环检查（重新计数/防抖）
            dirty = false;
            continue;
          }
        }
        // 若 hasForceTrigger 为 true，则跳过数量检查，直接进入资源等待

        // 在开始耗时等待前，先将 dirty 置为 false。
        // 这样如果在等待期间有新消息入队，dirty 会被重新置为 true，
        // 从而在等待结束后能正确检测到新消息。
        dirty = false;

        // 等待异步资源处理完成
        // 无论是哪种模式，只要决定处理，就等待所有相关资源的下载/转述。
        // 如果在此期间有新消息（dirty 变动），则放弃本次触发，重新开始循环，
        // 以便将新消息纳入处理范围（实现图片处理期间的防抖合并）。
        log.info(`开始处理 ${unprocessed.length} 条消息的资源...`);
        const resolvedMediaMaps = await Promise.all(unprocessed.map((m) => m.resourcesPromise!));

        if (dirty) {
          log.info("资源等待期间收到新消息，重新开始评估循环");
          dirty = false;
          continue;
        }

        // 标记已评估
        for (const m of unprocessed) {
          m.evaluated = true;
        }

        // 最终触发判定
        let shouldTrigger = false;

        if (hasForceTrigger) {
          // 硬触发，被 AT/私聊消息触发
          // 无需调用 dispatchMessage，直接触发回复
          shouldTrigger = true;
        } else {
          // 软触发，被群聊普通消息触发（主动插话逻辑）
          // 当前 dispatchMessage 只消费 path / description，
          // 因此这里把图片和视频都压平成旧的 ImageMap 结构，避免改动 dispatcher。
          const globalImageMap: ImageMap = new Map();
          for (const map of resolvedMediaMaps) {
            for (const [url, media] of map) {
              globalImageMap.set(url, {
                path: media.path,
                description: media.description,
              });
            }
          }
          // shouldTrigger = await dispatchMessage(unprocessed, globalImageMap);
          // 禁用主动插话逻辑
          shouldTrigger = false;
        }

        if (shouldTrigger) {
          scheduler.arm(ctx);
          break;
        }
        // 若判定不触发，退出循环
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
      // 启动资源预处理（不阻塞入队）
      message.resourcesPromise = (async () => {
        const resources = new Map<string, MediaResource>();

        const extractResources = (segments: UnifiedInboundMessage[]) => {
          for (const seg of segments) {
            if (seg.type === "image") {
              resources.set(`image:${seg.data.url}`, {
                url: seg.data.url,
                kind: "image",
              });
            } else if (seg.type === "video") {
              resources.set(`video:${seg.data.url}`, {
                url: seg.data.url,
                kind: "video",
              });
            } else if (seg.type === "reply") {
              extractResources(seg.data.segments);
            }
          }
        };

        extractResources(message.unifiedMessages);

        return await processMediaAssets(Array.from(resources.values()));
      })();

      message.evaluated = false;
      scheduler.enqueue(message, ctx);

      // 更新状态，触发循环
      lastMsgAt = Date.now();
      dirty = true;

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
  const { db } = await import("@/database/db");
  const { apply } = await import("@/database/migration");
  await apply(db);

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
      };
      getBot(sessionId).enqueue(message, ctx);
    } catch (error) {
      logger.error({ sessionId, error }, "消息解析或入队失败");
    }
  });
}
