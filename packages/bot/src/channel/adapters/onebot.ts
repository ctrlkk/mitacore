import type { OneBotIncomingMessageSegment, OneBotMessageEvent } from "channels/onebot";
import type { PendingMessage, UnifiedInboundMessage } from "@/message/types";
import type { ChannelReplyContext } from "@/channel/types";
import { createBot } from "@/app/queue-loop";
import { config, type Config } from "@/config";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { OneBotClient, type OneBotEventContext } from "channels/onebot";
import { resolveMentions } from "@/message/mention";
import { startBuiltinNapCat } from "@/napcat/loader";
import { logger } from "@/logger";
import { channelController } from "@/app/channel-controller";

const ENABLE_VIDEO_PROCESSING = false;

function isIdInScope(id: string, scope: Config["napcat"]["groups"]): boolean {
  const isInList = scope.ids.includes(id);
  if (scope.mode === "whitelist") return isInList;
  return !isInList;
}

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
      if (!ENABLE_VIDEO_PROCESSING) continue;
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
      const inner = await parseOneBotMessage(result.message, getNickname, () => Promise.resolve(null));
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
): Promise<boolean> {
  if (rawText !== "/ping" || !isAdmin) return false;
  const event = ctx.event;
  const latency = Date.now() - event.time * 1000;
  await ctx.reply(`pong (${latency}ms)`);
  return true;
}

function guessFileType(fileName: string): "image" | "video" | "audio" | "other" {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico"].includes(ext)) return "image";
  if (["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "flac", "aac", "silk", "amr"].includes(ext)) return "audio";
  return "other";
}

async function startNapCatChannel(getBot: (sessionId: string) => ReturnType<typeof createBot>) {
  let wsUrl: string;
  let accessToken: string;

  if (config.napcat.qq_id) {
    channelController.updateNapcat({ status: "starting", error: undefined });
    try {
      const result = await startBuiltinNapCat(config.napcat.qq_id);
      wsUrl = result.wsUrl;
      accessToken = result.accessToken;
      channelController.updateNapcat({ status: "ready", embed_url: result.webuiUrl });
    } catch (error) {
      channelController.updateNapcat({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } else {
    wsUrl = config.napcat.ws_url!;
    accessToken = config.napcat.token ?? "";
    channelController.updateNapcat({ status: "external", embed_url: undefined, error: undefined });
    logger.info({ wsUrl }, "使用外置 NapCat");
  }

  const bot = new OneBotClient({ url: wsUrl, accessToken, reconnect: true });
  await bot.connect();

  const user = await bot.getLoginInfo();
  const selfId = String(user.user_id);
  ensureUserAlias("onebot", selfId, user.nickname);
  logger.info({ selfId, nickname: user.nickname }, "Bot 已连接并运行");

  bot.onMessage(async (event, ctx) => {
    const segments = event.message;
    let isAt = false;
    if (event.message_type === "group") {
      if (!isIdInScope(String(event.group_id), config.napcat.groups)) return;
      if (!isIdInScope(String(event.user_id), config.napcat.group_members)) return;
      isAt = segments.some((seg) => seg.type === "at" && seg.data.qq === selfId);
    } else if (event.message_type === "private") {
      if (!isIdInScope(String(event.user_id), config.napcat.private_chats)) return;
      isAt = true;
    } else {
      return;
    }

    const isAdmin = true;
    const alias = ensureUserAlias("onebot", String(event.user_id), event.sender.nickname);
    const rawText = segments
      .filter((seg) => seg.type === "text")
      .map((seg) => seg.data.text)
      .join(" ")
      .trim();
    const sessionId = event.message_type === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;

    if (isAt && (await handleCommand(rawText, ctx, isAdmin))) return;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.type !== "file") continue;
      const fileType = guessFileType(seg.data.file);
      if (fileType !== "image" && !(ENABLE_VIDEO_PROCESSING && fileType === "video")) continue;

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

      segments[i] = { type: fileType, data: { file: url, url, file_size: seg.data.file_size } };
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
      const channelContext: ChannelReplyContext = {
        platform: "onebot",
        conversationType: event.message_type,
        selfId,
        reply: async (part, mentionableUsers = []) =>
          await ctx.reply(typeof part === "string" ? resolveMentions(part, mentionableUsers) : part),
        setTyping: async () => await ctx.setTyping(),
      };
      getBot(sessionId).enqueue(message, channelContext);
    } catch (error) {
      logger.error({ sessionId, error }, "消息解析或入队失败");
    }
  });
}

export async function startOneBotChannel(getBot: (sessionId: string) => ReturnType<typeof createBot>) {
  await startNapCatChannel(getBot);
}
