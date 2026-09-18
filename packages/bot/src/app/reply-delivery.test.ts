import { describe, expect, test, vi } from "vitest";
import type { ChannelReplyContext } from "@/channel/types";
import type { MessagePart, ReplyOutput } from "@/message/parts";
import type { PendingMessage } from "@/message/types";
import { deliverReply, getLatestUserText } from "./reply-delivery";

function createContext(platform: ChannelReplyContext["platform"], onReply?: (message: MessagePart) => void) {
  return {
    platform,
    conversationType: "private",
    selfId: "bot",
    reply: vi.fn(async (message: MessagePart) => onReply?.(message)),
    setTyping: vi.fn(async () => () => undefined),
  } satisfies ChannelReplyContext;
}

const output: ReplyOutput = {
  segments: ["今天很好", "明天也好！"],
  speechText: "今天很好。明天也好！",
};

describe("getLatestUserText", () => {
  test("只提取最后一条消息的普通文本", () => {
    const batch: PendingMessage[] = [
      {
        userId: "u1",
        nickname: "用户一",
        date: new Date(),
        isAt: false,
        unifiedMessages: [{ type: "text", text: "较早的消息" }],
      },
      {
        userId: "u2",
        nickname: "用户二",
        date: new Date(),
        isAt: true,
        unifiedMessages: [
          {
            type: "reply",
            data: { userId: "u1", nickname: "用户一", segments: [{ type: "text", text: "引用内容" }] },
          },
          { type: "text", text: " 这是" },
          { type: "image", data: { url: "https://example.test/image.png" } },
          { type: "text", text: "最新消息 " },
        ],
      },
    ];

    expect(getLatestUserText(batch)).toBe("这是最新消息");
  });

  test("最后一条消息没有正文时不提供上下文", () => {
    const batch: PendingMessage[] = [
      {
        userId: "u1",
        nickname: "用户一",
        date: new Date(),
        isAt: false,
        unifiedMessages: [{ type: "image", data: { url: "https://example.test/image.png" } }],
      },
    ];

    expect(getLatestUserText(batch)).toBeUndefined();
  });
});

describe("deliverReply", () => {
  test("不支持音频的渠道只发送文本", async () => {
    const synthesizeSpeech = vi.fn();
    const ctx = createContext("weixin");

    await deliverReply(output, ctx, undefined, undefined, { delayMs: 0, synthesizeSpeech });

    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });
});
