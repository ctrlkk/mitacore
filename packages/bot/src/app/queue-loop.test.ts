import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelReplyContext } from "@/channel/types";
import type { PendingMessage } from "@/message/types";

const mocks = vi.hoisted(() => ({
  downloadToCache: vi.fn(async (url: string) => ({
    virtualPath: `/images/${encodeURIComponent(url)}`,
    realPath: "test-image.png",
  })),
  imageToText: vi.fn(async () => "测试图片"),
  runPlanner: vi.fn(async (_prompt: string) => true),
}));

vi.mock("@/agents/multimedia", () => ({
  audioToText: vi.fn(async () => "测试音频"),
  imageToText: mocks.imageToText,
  videoToText: vi.fn(async () => "测试视频"),
}));

vi.mock("@/agents/planner", () => ({ runPlanner: mocks.runPlanner }));
vi.mock("@/agents/agent", () => ({ runMain: vi.fn(async () => undefined) }));
vi.mock("@/database/media-cache", () => ({
  get_media_description: vi.fn(() => undefined),
  set_media_description: vi.fn(),
}));
vi.mock("@/utils/fs-file", () => ({ createFsFile: vi.fn(async () => new Blob()) }));
vi.mock("@/utils/image-cache", () => ({ downloadToCache: mocks.downloadToCache }));
vi.mock("@/utils/image-resize", () => ({ compressImage: vi.fn(async () => new Blob()) }));
vi.mock("@/utils/video-resize", () => ({ compressVideo: vi.fn(async () => new Blob()) }));
vi.mock("./reply-delivery", () => ({
  deliverReply: vi.fn(async () => undefined),
  getLatestUserText: vi.fn(() => "测试消息"),
}));
vi.mock("@/logger", () => {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { logger };
});

import { createBot } from "@/app/queue-loop";
import { config } from "@/config";

const originalAgentMode = process.env.AGENT;

function createContext(conversationType: ChannelReplyContext["conversationType"]): ChannelReplyContext {
  return {
    platform: "onebot",
    conversationType,
    selfId: "bot",
    reply: vi.fn(async () => undefined),
    setTyping: vi.fn(async () => vi.fn()),
  };
}

function createTextMessage(text: string, isAt = false): PendingMessage {
  return {
    userId: "u1",
    nickname: "用户",
    date: new Date(),
    isAt,
    unifiedMessages: [{ type: "text", text }],
  };
}

function createImageMessage(url: string, isAt = false): PendingMessage {
  return {
    ...createTextMessage("", isAt),
    unifiedMessages: [{ type: "image", data: { url } }],
  };
}

async function advanceEvaluationLoop() {
  await vi.advanceTimersByTimeAsync(config.debounce_ms + 200);
  await Promise.resolve();
  await Promise.resolve();
}

describe("群聊媒体预处理", () => {
  beforeEach(() => {
    delete process.env.AGENT;
    vi.useFakeTimers();
    vi.clearAllMocks();
    config.preprocess_group_media = true;
  });

  afterEach(() => {
    if (originalAgentMode === undefined) delete process.env.AGENT;
    else process.env.AGENT = originalAgentMode;
    config.preprocess_group_media = true;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("开启时在群聊消息入队后立即处理媒体", () => {
    const bot = createBot("group:eager");

    bot.enqueue(createImageMessage("https://example.test/eager.png"), createContext("group"));

    expect(mocks.downloadToCache).toHaveBeenCalledWith("https://example.test/eager.png", {
      limit: 5 * 1024 * 1024,
    });
  });

  it("关闭时不处理普通群聊媒体", async () => {
    config.preprocess_group_media = false;
    const bot = createBot("group:lazy");

    bot.enqueue(createImageMessage("https://example.test/lazy.png"), createContext("group"));
    await advanceEvaluationLoop();

    expect(mocks.downloadToCache).not.toHaveBeenCalled();
    expect(mocks.imageToText).not.toHaveBeenCalled();
    expect(mocks.runPlanner).not.toHaveBeenCalled();
  });

  it("关闭时在硬触发后处理完整积压批次中的媒体", async () => {
    config.preprocess_group_media = false;
    const bot = createBot("group:deferred");
    const ctx = createContext("group");
    const url = "https://example.test/deferred.png";

    bot.enqueue(createImageMessage(url), ctx);
    for (let index = 1; index < 5; index++) {
      bot.enqueue(createTextMessage(`普通消息 ${index}`), ctx);
    }
    await advanceEvaluationLoop();
    expect(mocks.downloadToCache).not.toHaveBeenCalled();

    bot.enqueue(createTextMessage("@机器人", true), ctx);
    await advanceEvaluationLoop();

    expect(mocks.downloadToCache).toHaveBeenCalledWith(url, { limit: 5 * 1024 * 1024 });
    expect(mocks.runPlanner).toHaveBeenCalledTimes(1);
    expect(mocks.runPlanner.mock.calls[0]?.[0]).toContain("测试图片");
  });

  it("关闭群聊预处理时私聊仍立即处理媒体", () => {
    config.preprocess_group_media = false;
    const bot = createBot("private:eager");

    bot.enqueue(createImageMessage("https://example.test/private.png", true), createContext("private"));

    expect(mocks.downloadToCache).toHaveBeenCalledWith("https://example.test/private.png", {
      limit: 5 * 1024 * 1024,
    });
  });
});
