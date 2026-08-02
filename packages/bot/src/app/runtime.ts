import type { OneBotIncomingMessageSegment, OneBotMessageEvent } from "@/onebot/websocket-client";
import type { PendingMessage, UnifiedInboundMessage } from "@/message/types";
import type { LanguageModelUsage } from "ai";
import { OneBotClient, type OneBotEventContext } from "@/onebot/onebot-client";
import { startBuiltinNapCat } from "@/napcat/loader";
import { registerShutdownHook } from "@/utils/shutdown";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { config, type Config } from "@/config";
import { createBot } from "@/app/queue-loop";
import { cache } from "@/utils/cache";
import { logger } from "@/logger";

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

/**
 * 解析OneBot消息段落为统一格式
 * @param segments OneBot消息段落
 * @param getNickname 获取用户昵称的函数
 * @param getMessage 获取回复消息的函数
 * @returns 解析后的统一格式消息段落
 */
async function parseOneBotMessage(
  segments: OneBotIncomingMessageSegment[],
  getNickname: (qq: number) => Promise<string>,
  getMessage: (id: number) => Promise<{ userId: number; message: OneBotIncomingMessageSegment[] } | null>,
) {
  const messages: UnifiedInboundMessage[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      messages.push({ type: "text", text: seg.data.text });
    } else if (seg.type === "at") {
      const nickname = await getNickname(Number(seg.data.qq));
      const alias = ensureUserAlias("onebot", seg.data.qq, nickname);
      messages.push({ type: "at", data: { userId: shortIdFor(alias.id), nickname: nickname ?? " " } });
    } else if (seg.type === "image") {
      if (Number(seg.data.file_size) < 5 * 1024 * 1024) {
        messages.push({ type: "image", data: { url: seg.data.url } });
      } else {
        logger.info({ url: seg.data.url }, "忽略图片，大小超过5MB");
      }
    } else if (seg.type === "video") {
      const url = seg.data.url;
      if (!url) {
        logger.warn("视频消息缺少 url，跳过处理");
        continue;
      }
      if (Number(seg.data.file_size) < 20 * 1024 * 1024) {
        messages.push({ type: "video", data: { url } });
      } else {
        logger.info({ url }, "忽略视频，大小超过20MB");
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

export async function startBot() {
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

  const user = await bot.getLoginInfo();
  const selfId = String(user.user_id);
  ensureUserAlias("onebot", selfId, user.nickname);

  logger.info({ selfId, nickname: user.nickname }, "Bot 已连接并运行");

  const getBot = (() => {
    const botMap = new Map<string, ReturnType<typeof createBot>>();
    return (sessionId: string) => {
      let bot = botMap.get(sessionId);
      if (!bot) {
        bot = createBot(sessionId);
        botMap.set(sessionId, bot);
      }
      return bot;
    };
  })();

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
    // 把发送者写进用户映射表（首次见到时建立短号）
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

    /** 根据文件名扩展名猜测文件类型（NapCat 不提供 MIME 信息，只能靠扩展名） */
    function guessFileType(fileName: string): "image" | "video" | "audio" | "other" {
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico"].includes(ext)) return "image";
      if (["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv"].includes(ext)) return "video";
      if (["mp3", "wav", "ogg", "flac", "aac", "silk", "amr"].includes(ext)) return "audio";
      return "other";
    }

    // 将 file 消息段映射为 image/video，以便 parseOneBotMessage 能识别
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.type !== "file") continue;
      const fileType = guessFileType(seg.data.file);
      if (fileType !== "image" && fileType !== "video") continue;

      const url = await (async () => {
        if (seg.data.url) return seg.data.url;
        return await (
          event.message_type === "group"
            ? ctx.client.getGroupFileUrl(event.group_id, seg.data.file_id)
            : ctx.client.getPrivateFileUrl(seg.data.file_id)
        ).then((res) => res.url);
      })();
      if (!url) {
        logger.warn({ fileId: seg.data.file_id, fileName: seg.data.file }, "无法获取文件下载 URL，跳过映射");
        continue;
      }

      if (fileType === "image") {
        segments[i] = { type: "image", data: { file: url, url, file_size: seg.data.file_size } };
      } else if (fileType === "video") {
        segments[i] = { type: "video", data: { file: url, url, file_size: seg.data.file_size } };
      }
    }

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
          return { userId: user_id, message };
        },
      );

      if (unified.length === 0) {
        logger.debug({ sessionId, messageType: event.message_type }, "没有可解析的消息内容，跳过当前输入");
        return;
      }

      const message: PendingMessage = {
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
