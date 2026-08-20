import type { OneBotIncomingMessageSegment } from "channels/onebot";
import type { PendingMessage, UnifiedInboundMessage } from "@/message/types";
import type { ChannelReplyContext } from "@/channel/types";
import { createBot } from "@/app/queue-loop";
import { handleCommand } from "@/app/command";
import { config, type Config } from "@/config";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { OneBotClient } from "channels/onebot";
import { resolveMentions } from "@/message/mention";
import { startBuiltinNapCat } from "napcat";
import { logger } from "@/logger";
import { channelController } from "@/app/channel-controller";
import { binPath, dataPath, projectPath } from "@/utils/path";

const ENABLE_VIDEO_PROCESSING = true;

function exceedsSize(fileSize: number | string | undefined, limit: number): boolean {
  const size = Number(fileSize);
  return Number.isFinite(size) && size > limit;
}

function isIdInScope(id: string, scope: Config["napcat"]["groups"]): boolean {
  const isInList = scope.ids.includes(id);
  if (scope.mode === "whitelist") return isInList;
  return !isInList;
}

async function parseOneBotMessage(
  segments: OneBotIncomingMessageSegment[],
  getNickname: (qq: number) => Promise<string>,
  getMessage: (id: number) => Promise<{ userId: number; message: OneBotIncomingMessageSegment[] } | null>,
  getRecordDataUrl: (file: string) => Promise<string | undefined>,
  allowVideo: boolean,
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
      const url = seg.data.url!;
      if (exceedsSize(seg.data.file_size, 5 * 1024 * 1024)) {
        logger.info({ url: seg.data.url }, "忽略图片，大小超过5MB");
      } else {
        messages.push({ type: "image", data: { url } });
      }
    } else if (seg.type === "video") {
      if (!ENABLE_VIDEO_PROCESSING || !allowVideo) continue;
      const url = seg.data.url!;
      if (exceedsSize(seg.data.file_size, 20 * 1024 * 1024)) {
        logger.info({ url }, "忽略视频，大小超过20MB");
      } else {
        messages.push({ type: "video", data: { url } });
      }
    } else if (seg.type === "record") {
      const url = await getRecordDataUrl(seg.data.file);
      if (!url) {
        logger.warn({ file: seg.data.file }, "语音消息缺少可用音频内容，跳过处理");
      } else if (exceedsSize(seg.data.file_size, 5 * 1024 * 1024)) {
        logger.info({ file: seg.data.file }, "忽略语音，大小超过5MB");
      } else {
        messages.push({ type: "audio", data: { url } });
      }
    } else if (seg.type === "file") {
      if (guessFileType(seg.data.file) !== "audio") continue;

      const url = seg.data.url!;
      if (exceedsSize(seg.data.file_size, 5 * 1024 * 1024)) {
        logger.info({ fileId: seg.data.file_id, fileName: seg.data.file }, "忽略音频文件，大小超过5MB");
      } else {
        messages.push({ type: "audio", data: { url } });
      }
    } else if (seg.type === "reply") {
      const result = await getMessage(Number(seg.data.id));
      if (!result) continue;
      const inner = await parseOneBotMessage(
        result.message,
        getNickname,
        () => Promise.resolve(null),
        getRecordDataUrl,
        allowVideo,
      );
      if (inner.length === 0) continue;
      const nickname = await getNickname(result.userId);
      const alias = ensureUserAlias("onebot", String(result.userId), nickname);
      messages.push({ type: "reply", data: { userId: shortIdFor(alias.id), nickname, segments: inner } });
    }
  }
  return messages;
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
      const supervisorName = `napcat-supervisor${process.platform === "win32" ? ".exe" : ""}`;
      const result = await startBuiltinNapCat({
        qqId: config.napcat.qq_id,
        napcatDir: dataPath("runtime", "napcat"),
        runtimeDir: dataPath("runtime", "napcat"),
        qqPath: "",
        supervisorPaths: [
          binPath(supervisorName),
          projectPath("native", "napcat-supervisor", "target", "release", supervisorName),
        ],
        logger,
        onWebUiReady: (embed_url) =>
          channelController.updateNapcat({ status: "starting", embed_url, error: undefined }),
      });
      wsUrl = result.wsUrl;
      accessToken = result.accessToken;
      channelController.updateNapcat({ status: "ready", embed_url: result.webuiUrl });
    } catch (error) {
      channelController.updateNapcat({
        status: "failed",
        embed_url: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } else if (config.napcat.ws_url && config.napcat.token) {
    wsUrl = config.napcat.ws_url;
    accessToken = config.napcat.token;
    channelController.updateNapcat({ status: "external", embed_url: undefined, error: undefined });
    logger.info({ wsUrl }, "使用外置 NapCat");
  } else {
    const message = "NapCat 必须配置 qq_id，或同时配置 ws_url 和 token；请完成配置后重启程序";
    channelController.updateNapcat({ status: "failed", embed_url: undefined, error: message });
    logger.warn(message);
    return;
  }

  const bot = new OneBotClient({ url: wsUrl, accessToken, reconnect: true });
  await bot.connect();

  const user = await bot.getLoginInfo();
  const selfId = String(user.user_id);
  ensureUserAlias("onebot", selfId, user.nickname);
  logger.info({ selfId, nickname: user.nickname }, "Bot 已连接并运行");

  bot.onMessage(async (event, ctx) => {
    const segments = event.message;
    const rawText = segments
      .filter((seg) => seg.type === "text")
      .map((seg) => seg.data.text)
      .join(" ")
      .trim();

    let isAt = false;
    if (event.message_type === "group") {
      if (!isIdInScope(String(event.group_id), config.napcat.groups)) return;
      if (!isIdInScope(String(event.user_id), config.napcat.group_members)) return;
      isAt =
        segments.some((seg) => seg.type === "at" && seg.data.qq === selfId) ||
        config.napcat.wake_keywords.some((keyword) => rawText.includes(keyword));
    } else if (event.message_type === "private") {
      if (!isIdInScope(String(event.user_id), config.napcat.private_chats)) return;
      isAt = true;
    } else {
      return;
    }

    const isAdmin = config.napcat.admins.includes(String(event.user_id));
    const alias = ensureUserAlias("onebot", String(event.user_id), event.sender.nickname);
    const sessionId = event.message_type === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;

    if (
      isAt &&
      (await handleCommand({
        rawText,
        isAdmin,
        latency: Date.now() - event.time * 1000,
        reply: async (message) => await ctx.reply(message),
        processing: getBot(sessionId).processing,
      }))
    ) {
      return;
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.type !== "file") continue;
      const fileType = guessFileType(seg.data.file);
      if (fileType !== "image" && !(ENABLE_VIDEO_PROCESSING && isAt && fileType === "video")) continue;
      const url = await (async () => {
        if (seg.data.url) return seg.data.url;
        return await (
          event.message_type === "group"
            ? ctx.client.getGroupFileUrl(event.group_id, seg.data.file_id)
            : ctx.client.getPrivateFileUrl(seg.data.file_id)
        ).then((res) => res.url);
      })();
      if (!url) {
        logger.warn({ fileId: seg.data.file_id, fileName: seg.data.file }, "无法获取文件URL，跳过映射");
        continue;
      }
      segments[i] = { type: fileType, data: { file: seg.data.file_id, url, file_size: seg.data.file_size } };
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
        async (file) => {
          const info = await ctx.client.getRecordInfo(file);
          if (!info.base64) return info.url;
          return info.base64.startsWith("data:") ? info.base64 : `data:audio/mpeg;base64,${info.base64}`;
        },
        isAt,
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
