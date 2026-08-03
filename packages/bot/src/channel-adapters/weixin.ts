import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WeixinClient, loginWithQr, type WeixinCredentials, type WeixinInboundSegment } from "channels/weixin";
import { config, saveConfig } from "@/config";
import type { ChannelReplyContext } from "@/channel/types";
import { channelController } from "@/app/channel-controller";
import { ensureUserAlias, shortIdFor } from "@/database/user-alias";
import type { PendingMessage, UnifiedInboundMessage } from "@/message/types";
import type { MessagePart } from "@/message/parts";
import { createBot } from "@/app/queue-loop";
import { logger } from "@/logger";
import { dataPath } from "@/utils/path";

function createSyncBufferStore(accountId: string) {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const syncPath = dataPath("weixin", "accounts", `${safeAccountId}.sync.json`);

  return {
    async load() {
      try {
        return (JSON.parse(await readFile(syncPath, "utf8")) as { get_updates_buf?: string }).get_updates_buf ?? "";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    },
    async save(value: string) {
      await mkdir(dirname(syncPath), { recursive: true });
      const temporaryPath = `${syncPath}.tmp-${process.pid}`;
      try {
        await writeFile(temporaryPath, JSON.stringify({ get_updates_buf: value }), "utf8");
        await rename(temporaryPath, syncPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

function toUnifiedSegments(segments: WeixinInboundSegment[]): UnifiedInboundMessage[] {
  return segments.flatMap((segment): UnifiedInboundMessage[] => {
    if (segment.type === "text") return [{ type: "text", text: segment.text }];
    if (segment.type === "image" || segment.type === "video") return [segment];
    return [
      {
        type: "reply",
        data: {
          userId: "unknown",
          nickname: segment.data.title,
          segments: toUnifiedSegments(segment.data.segments),
        },
      },
    ];
  });
}

function toWeixinMessage(part: MessagePart) {
  if (typeof part === "string") return part;
  return { type: "image" as const, url: part.data.file || part.data.url };
}

const clientLogger = {
  debug(message: string, details?: unknown) {
    logger.debug({ details }, message);
  },
  info(message: string, details?: unknown) {
    logger.info({ details }, message);
  },
  warn(message: string, details?: unknown) {
    logger.warn({ details }, message);
  },
  error(message: string, details?: unknown) {
    logger.error({ details }, message);
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
          onQrCode: (qrcode_content) => channelController.updateWeixin({ status: "waiting_qr", qrcode_content }),
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
      logger.info({ accountId: credentials.accountId }, "微信凭证已写入 config.toml");
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

  const client = new WeixinClient(credentials, createSyncBufferStore(credentials.accountId), { logger: clientLogger });
  void client
    .start(async (event) => {
      if (!isIdInScope(event.senderId, config.weixin.users)) return;

      const alias = ensureUserAlias("weixin", event.senderId, event.nickname);
      const unifiedMessages = toUnifiedSegments(event.segments);
      const rawText = unifiedMessages
        .filter((segment): segment is Extract<UnifiedInboundMessage, { type: "text" }> => segment.type === "text")
        .map((segment) => segment.text)
        .join(" ")
        .trim();

      if (rawText === "/ping") {
        const latency = event.message.create_time_ms ? Date.now() - event.message.create_time_ms : 0;
        await event.reply(`pong (${latency}ms)`);
        return;
      }

      const message: PendingMessage = {
        userId: shortIdFor(alias.id),
        unifiedMessages,
        nickname: event.nickname,
        date: new Date(event.message.create_time_ms ?? Date.now()),
        isAt: true,
      };
      const context: ChannelReplyContext = {
        platform: "weixin",
        conversationType: event.conversationType,
        selfId: credentials.accountId,
        reply: async (part) => await event.reply(toWeixinMessage(part)),
        setTyping: async () => await event.setTyping(),
      };
      getBot(event.sessionId).enqueue(message, context);
    })
    .catch((error) => logger.error({ error }, "微信渠道异常退出"));
}

function isIdInScope(id: string, scope: { mode: "whitelist" | "blacklist"; ids: string[] }) {
  const isInList = scope.ids.includes(id);
  return scope.mode === "whitelist" ? isInList : !isInList;
}
