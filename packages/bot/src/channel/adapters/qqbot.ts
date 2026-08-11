import type { ChannelReplyContext } from "@/channel/types";
import type { PendingMessage, UnifiedInboundMessage } from "@/message/types";
import type { MessagePart } from "@/message/parts";
import { createBot } from "@/app/queue-loop";
import { config, saveConfig } from "@/config";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { logger } from "@/logger";
import {
  QQBotClient,
  startQQBotQrLogin,
  type QQBotCredentials,
  type QQBotInboundMessage,
  type QQBotQrCredentials,
} from "channels/qqbot";

function toUnifiedMessages(inbound: QQBotInboundMessage): UnifiedInboundMessage[] {
  const messages: UnifiedInboundMessage[] = [];
  if (inbound.content.trim()) messages.push({ type: "text", text: inbound.content });
  for (const attachment of inbound.attachments) {
    if (attachment.content_type?.startsWith("image/") && attachment.url) {
      messages.push({ type: "image", data: { url: attachment.url } });
    }
  }
  return messages;
}

function toText(part: MessagePart) {
  return typeof part === "string" ? part : part.raw;
}

async function loginWithQr(): Promise<QQBotQrCredentials> {
  return await new Promise((resolve, reject) => {
    startQQBotQrLogin({
      onQrUrl: (url) => logger.info({ url }, "请使用 QQ 扫描此二维码链接"),
      onExpired: () => logger.info("QQ Bot 二维码已过期，正在生成新的二维码"),
      onSuccess: resolve,
      onError: reject,
    });
  });
}

export async function startQQBotChannel(getBot: (sessionId: string) => ReturnType<typeof createBot>) {
  const appId = process.env.QQBOT_APP_ID || config.qqbot.app_id;
  const appSecret = process.env.QQBOT_APP_SECRET || config.qqbot.app_secret;
  const configuredCredentials = appId && appSecret ? { appId, appSecret } : null;
  const credentials: QQBotCredentials = configuredCredentials ?? (await loginWithQr());

  if (!configuredCredentials) {
    await saveConfig({
      ...config,
      qqbot: { ...config.qqbot, app_id: credentials.appId, app_secret: credentials.appSecret },
    });
    logger.info({ appId: credentials.appId }, "QQ Bot 凭证已写入 config.toml");
  }

  const client = new QQBotClient(credentials);
  client.onReady(() => logger.info({ appId: credentials.appId }, "QQ Bot 已连接"));
  client.onError((error) => logger.error({ err: error }, "QQ Bot 异常"));
  client.onClose(({ code, reason }) => logger.warn({ code, reason }, "QQ Bot 连接关闭"));
  client.onMessage(async (inbound) => {
    try {
      const unifiedMessages = toUnifiedMessages(inbound);
      if (unifiedMessages.length === 0) return;

      const alias = ensureUserAlias("qqbot", inbound.senderId, inbound.senderName);
      const sessionId =
        inbound.kind === "group" ? `qqbot:group:${inbound.replyTarget.targetId}` : `qqbot:private:${inbound.senderId}`;
      const message: PendingMessage = {
        userId: shortIdFor(alias.id),
        unifiedMessages,
        nickname: inbound.senderName ?? "",
        date: inbound.timestamp ? new Date(inbound.timestamp) : new Date(),
        isAt: true,
      };
      const context: ChannelReplyContext = {
        platform: "qqbot",
        conversationType: inbound.kind === "group" ? "group" : "private",
        selfId: credentials.appId,
        reply: async (part) => await client.reply(inbound, toText(part)),
        setTyping: async () => () => undefined,
      };
      getBot(sessionId).enqueue(message, context);
    } catch (error) {
      logger.error({ err: error, messageId: inbound.messageId }, "QQ Bot 消息解析或入队失败");
    }
  });
  await client.connect();
}
