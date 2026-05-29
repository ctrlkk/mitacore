import {
  createNapCatChannel,
  NapCatChannel,
  type MessageSegment,
  type MessageEvent,
  type NapCatOptions,
  type NapCatEvents,
} from "./napcat-sdk";
import type { InboundMessage, UniversalMessage } from "./message";
import { extractText } from "./message";
import { Agent } from "../agent";
import type { ChatCompletionMessageParam } from "openai/resources";
import { readFile, mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import systemPrompt from "../prompts/贤惠幼妻仙狐小姐.md"
import summaryPrompt from "../prompts/summary.md";
import OpenAI from "openai";

/**
 * 从文件加载历史记录
 * @param name 历史记录文件名（不包含扩展名）
 * @returns 历史记录数组
 */
async function loadHistory(name: string): Promise<ChatCompletionMessageParam[]> {
  try {
    const history = await readFile(resolve('.cache', `${name}.json`), 'utf8');
    return JSON.parse(history);
  } catch {
    return [];
  }
}

/**
 * 保存历史记录到文件
 * @param name 历史记录文件名（不包含扩展名）
 * @param history 要保存的历史记录数组
 */
async function saveHistory(name: string, history: ChatCompletionMessageParam[]) {
  try {
    await mkdir(resolve('.cache'), { recursive: true });
    await writeFile(resolve('.cache', `${name}.json`), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error(`保存历史记录失败: ${error}`);
  }
}

/** 将 NapCat MessageSegment[] 转换为 UniversalMessage[] */
function parseNapCatSegments(segments: MessageSegment[]): UniversalMessage[] {
  return segments.map((seg): UniversalMessage => {
    switch (seg.type) {
      case "text":
        return { type: "text", text: seg.data.text ?? "" };
      case "image":
        return { type: "image", url: seg.data.url ?? seg.data.file ?? "" };
      case "at":
        return { type: "at", targetId: seg.data.qq ?? "" };
      case "reply":
        return { type: "reply", messageId: String(seg.data.id ?? ""), content: { type: "text", text: "" } };
      default:
        return { type: "platform", platform: "napcat", raw: seg };
    }
  });
}

/** 将 NapCat MessageEvent 转换为统一 InboundMessage */
export function fromNapCatMessage(event: MessageEvent): InboundMessage {
  const isGroup = event.message_type === "group";
  const segments = Array.isArray(event.message)
    ? parseNapCatSegments(event.message)
    : [{ type: "text" as const, text: String(event.message) }];

  return {
    platform: "napcat",
    chatId: isGroup ? `group:${event.group_id}` : `private:${event.user_id}`,
    senderId: String(event.user_id),
    messageId: String(event.message_id),
    text: extractText(segments),
    segments,
    timestamp: event.time * 1000,
    isGroup,
    raw: event,
  };
}

/** 发送消息的输入，类似飞书 LarkChannel 的 SendInput */
export type NapCatSendInput =
  | { text: string }
  | { image: string }
  | { at: { qq: number | "all"; text?: string } }
  | { reply: { message_id: number }; content: NapCatSendInput }
  | { face: number }
  | { segments: MessageSegment[] };

export interface NapCatSendOptions {
  /** 回复的消息 ID */
  replyTo?: number;
}

export interface NapCatSendResult {
  message_id: number;
}

/** 在 NapCatChannel 基础上封装高层消息发送方法 */
export class NapCatBot {
  private channel: NapCatChannel;

  constructor(options: NapCatOptions) {
    this.channel = createNapCatChannel(options);
  }

  /** 连接 WebSocket */
  connect(): Promise<void> {
    return this.channel.connect();
  }

  /** 断开连接 */
  disconnect(): void {
    this.channel.disconnect();
  }

  /** 监听事件 */
  on<U extends keyof NapCatEvents>(
    event: U,
    listener: NapCatEvents[U],
  ): this {
    this.channel.on(event, listener);
    return this;
  }

  /** 发送消息，自动判断私聊/群聊，类似飞书 channel.send(to, input) */
  async send(to: number, input: NapCatSendInput, opts?: NapCatSendOptions): Promise<NapCatSendResult> {
    const message = this.buildMessageSegments(input, opts);

    // 群号通常 >= 100000000，私聊 QQ 号通常较短
    const isGroup = String(to).length >= 8;

    if (isGroup) {
      try {
        const res = await this.channel.callApi("send_group_msg", {
          group_id: to,
          message,
        });
        return { message_id: res.data.message_id };
      } catch {
        // 群聊发送失败，回退私聊
      }
    }

    const res = await this.channel.callApi("send_private_msg", {
      user_id: to,
      message,
    });
    return { message_id: res.data.message_id };
  }

  /** 发送私聊消息 */
  async sendPrivate(userId: number, input: NapCatSendInput, opts?: NapCatSendOptions): Promise<NapCatSendResult> {
    const message = this.buildMessageSegments(input, opts);
    const res = await this.channel.callApi("send_private_msg", {
      user_id: userId,
      message,
    });
    return { message_id: res.data.message_id };
  }

  /** 发送群聊消息 */
  async sendGroup(groupId: number, input: NapCatSendInput, opts?: NapCatSendOptions): Promise<NapCatSendResult> {
    const message = this.buildMessageSegments(input, opts);
    const res = await this.channel.callApi("send_group_msg", {
      group_id: groupId,
      message,
    });
    return { message_id: res.data.message_id };
  }

  /** 撤回消息 */
  async recallMessage(messageId: number): Promise<void> {
    await this.channel.callApi("delete_msg", { message_id: messageId });
  }

  /** 获取原始 channel 实例，用于 callApi 等底层操作 */
  get raw(): NapCatChannel {
    return this.channel;
  }

  /** 将 NapCatSendInput 转换为 MessageSegment[] */
  private buildMessageSegments(input: NapCatSendInput, opts?: NapCatSendOptions): MessageSegment[] {
    const segments: MessageSegment[] = [];

    if (opts?.replyTo) {
      segments.push({ type: "reply", data: { id: opts.replyTo } });
    }

    if ("text" in input) {
      segments.push({ type: "text", data: { text: input.text } });
    } else if ("image" in input) {
      segments.push({ type: "image", data: { file: input.image } });
    } else if ("at" in input) {
      segments.push({
        type: "at",
        data: { qq: input.at.qq === "all" ? "all" : String(input.at.qq) },
      });
      if (input.at.text) {
        segments.push({ type: "text", data: { text: input.at.text } });
      }
    } else if ("reply" in input) {
      segments.push({ type: "reply", data: { id: input.reply.message_id } });
      segments.push(...this.buildMessageSegments(input.content));
    } else if ("face" in input) {
      segments.push({ type: "face", data: { id: input.face } });
    } else if ("segments" in input) {
      segments.push(...input.segments);
    }

    return segments;
  }
}

async function main() {
  const bot = new NapCatBot({
    wsUrl: "ws://127.0.0.1:3001",
    token: "your_token",
  });

  bot.on("message", async (msg: MessageEvent) => {
  });

  bot.on("notice", (notice) => {
    if (notice.notice_type === "notify" && notice.sub_type === "poke") {
      console.log(`有人戳了戳: ${notice.target_id}`);
    }
  });

  await bot.connect();
}

await main();
