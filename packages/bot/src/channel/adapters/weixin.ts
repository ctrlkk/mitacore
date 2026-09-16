import type { ChannelReplyContext } from "@/channel/types";
import type { PendingMessage, UnifiedInboundMessage } from "@/message/types";
import type { MessagePart } from "@/message/parts";
import { WeixinClient, loginWithQr, type WeixinCredentials, type WeixinInboundSegment } from "channels/weixin";
import { config, saveConfig } from "@/config";
import { channelController } from "@/app/channel-controller";
import { handleCommand } from "@/app/command";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import { createBot } from "@/app/queue-loop";
import { logger } from "@/logger";
import { createWeixinSyncBufferStore } from "@/channel/weixin-sync-store";

const WEIXIN_USER_NICKNAME = "";
const WEIXIN_USER_KEY = "direct";

function toUnifiedSegments(segments: WeixinInboundSegment[], userId: string): UnifiedInboundMessage[] {
  return segments.flatMap((segment): UnifiedInboundMessage[] => {
    if (segment.type === "text") return [{ type: "text", text: segment.text }];
    if (segment.type === "image" || segment.type === "video") return [segment];
    return [
      {
        type: "reply",
        data: {
          userId,
          nickname: segment.data.title,
          segments: toUnifiedSegments(segment.data.segments, userId),
        },
      },
    ];
  });
}

function toWeixinMessage(part: MessagePart) {
  if (typeof part === "string") return part;
  if (part.type === "audio") throw new Error("微信不支持发送音频消息");
  return { type: "image" as const, url: part.data.file || part.data.url };
}

function toLogFields(details: unknown): object {
  if (details instanceof Error) return { err: details };
  if (details !== null && typeof details === "object") return details;
  return details === undefined ? {} : { details };
}

const clientLogger = {
  debug(message: string, details?: unknown) {
    logger.debug(toLogFields(details), message);
  },
  info(message: string, details?: unknown) {
    logger.info(toLogFields(details), message);
  },
  warn(message: string, details?: unknown) {
    logger.warn(toLogFields(details), message);
  },
  error(message: string, details?: unknown) {
    logger.error(toLogFields(details), message);
  },
};

export async function startWeixinChannel(getBot: (sessionId: string) => ReturnType<typeof createBot>) {
  const configuredCredentials = (() => {
    if (!config.weixin.account_id || !config.weixin.token) return null;
    return {
      accountId: config.weixin.account_id,
      token: config.weixin.token,
    } satisfies WeixinCredentials;
  })();
  const credentials =
    configuredCredentials ??
    (await channelController.loginWithQr(
      async (waitForVerifyCode) =>
        await loginWithQr({
          onQrCode: (qrcode_content) => {
            logger.info({ url: qrcode_content }, "请使用微信扫描此二维码链接");
            channelController.updateWeixin({ status: "waiting_qr", qrcode_content });
          },
          onScanned: () => channelController.updateWeixin({ status: "scanned" }),
          onVerifyCodeRequired: () => channelController.updateWeixin({ status: "waiting_verify_code" }),
          waitForVerifyCode,
        }),
    ));

  if (!configuredCredentials) {
    try {
      await saveConfig({
        ...config,
        weixin: {
          ...config.weixin,
          account_id: credentials.accountId,
          token: credentials.token,
        },
      });
      logger.info({ accountId: credentials.accountId }, "微信凭证已写入配置文件");
    } catch (error) {
      channelController.updateWeixin({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  channelController.updateWeixin({ status: "ready", qrcode_content: undefined, error: undefined });
  ensureUserAlias("weixin", credentials.accountId, "微信 Bot");
  const userAlias = ensureUserAlias("weixin", WEIXIN_USER_KEY, WEIXIN_USER_NICKNAME);
  const userId = shortIdFor(userAlias.id);

  const client = new WeixinClient(credentials, createWeixinSyncBufferStore(credentials.accountId), {
    logger: clientLogger,
  });
  void client
    .start(async (inbound) => {
      const unifiedMessages = toUnifiedSegments(inbound.segments, userId);
      const rawText = unifiedMessages
        .filter((segment): segment is Extract<UnifiedInboundMessage, { type: "text" }> => segment.type === "text")
        .map((segment) => segment.text)
        .join(" ")
        .trim();

      if (
        await handleCommand({
          rawText,
          isAdmin: true,
          latency: inbound.message.create_time_ms ? Date.now() - inbound.message.create_time_ms : 0,
          reply: async (message) => await client.reply(inbound.message, message),
          processing: getBot(`weixin:${WEIXIN_USER_KEY}`).processing,
        })
      ) {
        return;
      }

      const message: PendingMessage = {
        userId,
        unifiedMessages,
        nickname: WEIXIN_USER_NICKNAME,
        date: new Date(inbound.message.create_time_ms ?? Date.now()),
        isAt: true,
      };
      const context: ChannelReplyContext = {
        platform: "weixin",
        conversationType: "private",
        selfId: credentials.accountId,
        reply: async (part) => await client.reply(inbound.message, toWeixinMessage(part)),
        setTyping: async () => await client.setTyping(inbound.message),
      };
      getBot(`weixin:${WEIXIN_USER_KEY}`).enqueue(message, context);
    })
    .catch((error) => logger.error({ err: error }, "微信渠道异常退出"));
}
