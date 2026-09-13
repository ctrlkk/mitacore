import { describe, expect, test, vi } from "vitest";
import type { ChannelReplyContext } from "@/channel/types";
import type { AudioPart, MessagePart, ReplyOutput } from "@/message/parts";
import type { PendingMessage } from "@/message/types";
import type { PinoLogger } from "@/logger";
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
  test("OneBot 并行合成并在文本后发送整段语音", async () => {
    const events: string[] = [];
    const audio: AudioPart = { type: "audio", blob: new Blob(["audio"], { type: "audio/mpeg" }) };
    let resolveSpeech!: (audio: AudioPart) => void;
    const synthesizeSpeech = vi.fn(() => {
      events.push("synthesize");
      return new Promise<AudioPart>((resolve) => {
        resolveSpeech = resolve;
      });
    });
    const ctx = createContext("onebot", (message) => {
      events.push(typeof message === "string" ? message : message.type);
    });
    const log = { warn: vi.fn() } as unknown as PinoLogger;

    const delivery = deliverReply(output, ctx, "用户上下文。", log, { delayMs: 0, synthesizeSpeech });

    await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledTimes(2));
    expect(events).toEqual(["synthesize", "今天很好", "明天也好！"]);

    resolveSpeech(audio);
    await delivery;

    expect(synthesizeSpeech).toHaveBeenCalledWith("今天很好。明天也好！", "用户上下文。", log);
    expect(events).toEqual(["synthesize", "今天很好", "明天也好！", "audio"]);
  });

  test("不支持音频的渠道只发送文本", async () => {
    const synthesizeSpeech = vi.fn();
    const ctx = createContext("weixin");

    await deliverReply(output, ctx, undefined, undefined, { delayMs: 0, synthesizeSpeech });

    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });

  test("语音合成失败时保留文本并记录降级日志", async () => {
    const error = new Error("服务不可用");
    const synthesizeSpeech = vi.fn().mockRejectedValue(error);
    const ctx = createContext("onebot");
    const log = { warn: vi.fn() } as unknown as PinoLogger;

    await deliverReply(output, ctx, undefined, log, { delayMs: 0, synthesizeSpeech });

    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({ error }, "回复语音合成失败，已降级为文本");
  });

  test("语音发送失败时不影响已经发送的文本", async () => {
    const error = new Error("音频发送失败");
    const audio: AudioPart = { type: "audio", blob: new Blob(["audio"], { type: "audio/mpeg" }) };
    const synthesizeSpeech = vi.fn().mockResolvedValue(audio);
    const ctx = createContext("onebot");
    ctx.reply.mockImplementation(async (message) => {
      if (typeof message !== "string") throw error;
    });
    const log = { warn: vi.fn() } as unknown as PinoLogger;

    await expect(deliverReply(output, ctx, undefined, log, { delayMs: 0, synthesizeSpeech })).resolves.toBeUndefined();

    expect(ctx.reply).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith({ error }, "回复语音发送失败，已保留文本");
  });
});
