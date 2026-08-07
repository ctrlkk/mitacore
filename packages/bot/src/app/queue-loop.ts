import os from "node:os";
import { basename, posix } from "node:path";
import XMLBuilder from "fast-xml-builder";
import dayjs, { sleep } from "shared/time";
import type { ChannelReplyContext } from "@/channel/types";
import type { MessagePart } from "@/message/parts";
import type { ImageMap, MediaKind, MediaMap, PendingMessage, UnifiedInboundMessage } from "@/message/types";
import { imageToText, videoToText } from "@/ai/multimedia";
import { runPlanner } from "@/agents/planner";
import { runPlanner as runContinuousPlanner } from "@/agents/planner-continuous";
import { config } from "@/config";
import { get_media_description, set_media_description } from "@/database/media-cache";
import { listMentionableUserAliases } from "@/database/user-alias";
import { logger } from "@/logger";
import { createFsFile } from "@/utils/fs-file";
import { downloadToCache } from "@/utils/image-cache";
import { compressImage } from "@/utils/image-resize";
import { compressVideo } from "@/utils/video-resize";

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
              const { downloadToCache } = await import("@/utils/blob");
              const { realPath } = await downloadToCache(url, { cacheDir: os.tmpdir(), limit: 20 * 1024 * 1024 });
              return { virtualPath: posix.join("/videos", basename(realPath)), realPath };
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
          const cached = get_media_description(cacheKey);
          if (cached) return cached;

          try {
            let result: string;

            if (item.kind === "image") {
              const blob = await compressImage(await createFsFile(item.realPath));
              result = (await imageToText(blob)).trim();
            } else {
              const blob = await compressVideo(await createFsFile(item.realPath));
              result = (await videoToText(blob)).trim();
            }

            set_media_description(item.kind, cacheKey, result);

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
    const parts = segments.flatMap((seg): { content: string; standalone: boolean }[] => {
      if (seg.type === "text") {
        return seg.text.length > 0 ? [{ content: seg.text, standalone: false }] : [];
      } else if (seg.type === "at") {
        return seg.data.nickname ? [{ content: `@${seg.data.nickname}`, standalone: false }] : [];
      } else if (seg.type === "image" || seg.type === "video") {
        const media = mediaMap.get(seg.data.url);

        if (media?.path) {
          return [{ content: `\`${media.path}\``, standalone: false }];
        }

        return [{ content: seg.type === "image" ? "[图片]" : "[视频]", standalone: false }];
      } else if (seg.type === "reply") {
        const inner = formatMessage(seg.data.segments);
        if (inner.length === 0) return [];

        return [
          {
            content: `<reply user_id="${seg.data.userId}" nickname="${seg.data.nickname}">${inner}</reply>`,
            standalone: true,
          },
        ];
      }

      return [];
    });

    // reply 是块级上下文，必须独占一行；其余片段属于当前消息正文，仍在同一行用空格分隔。
    return parts
      .map((part, index) => {
        const separator = index === 0 ? "" : part.standalone || parts[index - 1]?.standalone ? "\n" : "";
        return `${separator}${part.content}`;
      })
      .join("");
  };

  const today = dayjs();

  for (const msg of batch) {
    const text = formatMessage(msg.unifiedMessages);
    const fmt = dayjs(msg.date).isSame(today, "day") ? "HH:mm" : "MM-DD HH:mm";
    const block = `<user_input user_id="${msg.userId}" date="${dayjs(msg.date).format(fmt)}" nickname="${msg.nickname}">\n${text}\n</user_input>`;
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
export function createBot(sessionId: string) {
  const log = logger.child({ sessionId });

  async function processBatch(batch: PendingMessage[], ctx: ChannelReplyContext) {
    const mediaMaps = await Promise.all(batch.map((m) => m.resourcesPromise!));
    const mediaMap: MediaMap = new Map();
    for (const map of mediaMaps) {
      for (const [url, info] of map) {
        mediaMap.set(url, info);
      }
    }
    const prompt = buildPrompt(batch, mediaMap).trim();
    log.info({ prompt }, "用户输入");

    const cancelTyping = await ctx.setTyping();
    try {
      const onReply = async (segments: MessagePart[]) => {
        const mentionableUsers = (() => {
          if (ctx.platform !== "onebot" || ctx.conversationType !== "group") return [];
          if (segments.some((segment) => typeof segment === "string" && segment.includes("@"))) {
            return listMentionableUserAliases("onebot").filter((user) => user.platformId !== ctx.selfId);
          }
          return [];
        })();

        for (const seg of segments) {
          await ctx.reply(seg, mentionableUsers);
          await sleep(500);
        }
      };
      let replied: boolean;
      if (config.economy_mode) {
        replied = await runPlanner(prompt, onReply, log);
      } else {
        replied = await runContinuousPlanner(prompt, onReply, log);
      }
      if (!replied) {
        log.info("规划层未调用 submit_plan，跳过回复");
      }
    } finally {
      await cancelTyping();
    }
  }

  const scheduler = createScheduler(processBatch, { maxQueue: config.max_queue });
  scheduler.run().catch((error) => log.error({ error }, "scheduler 运行失败"));

  const debounceMs = config.debounce_ms;
  let lastMsgAt = Date.now();
  let dirty = false;
  let evaluating = false;

  async function evaluationLoop(ctx: ChannelReplyContext) {
    if (evaluating) {
      dirty = true;
      return;
    }
    evaluating = true;

    try {
      while (true) {
        // 等待用户停止输入 1s
        while (Date.now() - lastMsgAt < debounceMs) {
          await sleep(100);
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
    enqueue: (message: PendingMessage, ctx: ChannelReplyContext) => {
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
