import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelReplyContext } from "@/channel/types";
import type { Config } from "@/config";
import type { MessagePart } from "@/message/parts";
import type { UnifiedInboundMessage } from "@/message/types";
import { logger } from "@/logger";
import { dataPath } from "@/utils/path";
import { downloadMedia, getTypingTicket, getUpdates, notifyLifecycle, sendImage, sendText, sendTyping } from "./api";
import { MessageItemType, type MessageItem, type WeixinCredentials, type WeixinMessage } from "./protocol";

export interface WeixinInboundEvent {
  message: WeixinMessage;
  context: ChannelReplyContext;
  segments: UnifiedInboundMessage[];
  senderId: string;
  nickname: string;
  conversationType: "private" | "group";
  sessionId: string;
}

export class WeixinClient {
  private abortController: AbortController | null = null;
  private readonly contextTokens = new Map<string, string>();

  constructor(
    private readonly credentials: WeixinCredentials,
    private readonly options: Config["weixin"],
  ) {}

  private get syncPath() {
    const safeAccountId = this.credentials.accountId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return dataPath("weixin", "accounts", `${safeAccountId}.sync.json`);
  }

  async start(handler: (event: WeixinInboundEvent) => Promise<void>) {
    if (this.abortController) throw new Error("微信客户端已经启动");
    let syncBuffer = await this.loadSyncBuffer();
    const controller = new AbortController();
    this.abortController = controller;
    let timeoutMs = 35_000;
    let failures = 0;

    await notifyLifecycle(this.credentials, "start").catch((error) => {
      logger.warn({ error }, "通知微信渠道启动失败，继续运行");
    });
    logger.info({ accountId: this.credentials.accountId }, "微信渠道已连接");
    while (!controller.signal.aborted) {
      try {
        const response = await getUpdates(this.credentials, syncBuffer, timeoutMs, controller.signal);
        if (controller.signal.aborted) break;
        if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
          throw new Error(`getUpdates ret=${response.ret} errcode=${response.errcode}: ${response.errmsg ?? ""}`);
        }

        failures = 0;
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = response.longpolling_timeout_ms;
        }
        if (response.get_updates_buf) {
          syncBuffer = response.get_updates_buf;
          await this.saveSyncBuffer(syncBuffer);
        }
        for (const message of response.msgs ?? []) {
          const inbound = await this.normalizeMessage(message);
          if (inbound) await handler(inbound);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        failures += 1;
        logger.error({ error, failures }, "微信长轮询失败");
        await Bun.sleep(failures >= 3 ? 30_000 : 2_000);
        if (failures >= 3) failures = 0;
      }
    }
    if (this.abortController === controller) this.abortController = null;
  }

  async stop() {
    this.abortController?.abort();
    await notifyLifecycle(this.credentials, "stop").catch((error) => {
      logger.warn({ error }, "通知微信渠道停止失败");
    });
  }

  private async normalizeMessage(message: WeixinMessage): Promise<WeixinInboundEvent | null> {
    const senderId = message.from_user_id?.trim();
    if (!senderId || senderId === this.credentials.accountId || message.message_type === 2) return null;
    if (message.context_token) this.contextTokens.set(senderId, message.context_token);

    const segments = await this.parseItems(message.item_list ?? []);
    if (segments.length === 0) return null;
    const conversationType = message.group_id ? "group" : "private";
    const peerId = message.group_id || senderId;
    const sessionId = `weixin:${this.credentials.accountId}:${conversationType}:${peerId}`;
    const context: ChannelReplyContext = {
      platform: "weixin",
      conversationType,
      selfId: this.credentials.accountId,
      reply: async (part) => await this.reply(senderId, part),
      setTyping: async () => await this.setTyping(senderId),
    };

    return {
      message,
      context,
      segments,
      senderId,
      nickname: "",
      conversationType,
      sessionId,
    };
  }

  private async parseItems(items: MessageItem[]) {
    const segments: UnifiedInboundMessage[] = [];
    for (const item of items) {
      if (item.ref_msg?.message_item) {
        const inner = await this.parseItems([item.ref_msg.message_item]);
        if (inner.length > 0) {
          segments.push({
            type: "reply",
            data: { userId: "unknown", nickname: item.ref_msg.title || "引用消息", segments: inner },
          });
        }
      }
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        segments.push({ type: "text", text: item.text_item.text });
      } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
        segments.push({ type: "text", text: `[语音转文字] ${item.voice_item.text}` });
      } else if (item.type === MessageItemType.IMAGE || item.type === MessageItemType.VIDEO) {
        try {
          const buffer = await downloadMedia(item, this.options.cdn_base_url);
          if (!buffer) continue;
          const mime = item.type === MessageItemType.IMAGE ? this.guessImageMime(buffer) : "video/mp4";
          const url = `data:${mime};base64,${buffer.toString("base64")}`;
          if (item.type === MessageItemType.IMAGE) {
            segments.push({ type: "image", data: { url } });
          } else {
            segments.push({ type: "video", data: { url } });
          }
        } catch (error) {
          logger.error({ error, messageId: item.msg_id }, "微信媒体解析失败");
        }
      }
    }
    return segments;
  }

  private async reply(to: string, part: MessagePart) {
    const contextToken = this.contextTokens.get(to);
    if (typeof part === "string") return await sendText(this.credentials, to, contextToken, part);
    const response = await fetch(part.data.file || part.data.url);
    if (!response.ok) throw new Error(`读取待发送图片失败：HTTP ${response.status}`);
    return await sendImage(
      this.credentials,
      this.options.cdn_base_url,
      to,
      contextToken,
      Buffer.from(await response.arrayBuffer()),
    );
  }

  private async setTyping(to: string) {
    const contextToken = this.contextTokens.get(to);
    try {
      const config = await getTypingTicket(this.credentials, to, contextToken);
      if (!config.typing_ticket) return () => {};
      await sendTyping(this.credentials, to, config.typing_ticket, 1);
      return async () => {
        await sendTyping(this.credentials, to, config.typing_ticket!, 2).catch((error) => {
          logger.debug({ error }, "取消微信输入状态失败");
        });
      };
    } catch (error) {
      logger.debug({ error }, "设置微信输入状态失败");
      return () => {};
    }
  }

  private guessImageMime(buffer: Buffer) {
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
    if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
    if (buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    return "application/octet-stream";
  }

  private async loadSyncBuffer() {
    try {
      return (JSON.parse(await readFile(this.syncPath, "utf8")) as { get_updates_buf?: string }).get_updates_buf ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private async saveSyncBuffer(value: string) {
    await mkdir(dirname(this.syncPath), { recursive: true });
    const temporaryPath = `${this.syncPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryPath, JSON.stringify({ get_updates_buf: value }), "utf8");
      await rename(temporaryPath, this.syncPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
