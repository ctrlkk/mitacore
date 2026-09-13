import { expect, test, vi } from "vitest";
import type { PinoLogger } from "@/logger";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock("./doubao", () => ({
  DoubaoTtsClient: class {
    constructor(options: unknown) {
      mocks.constructor(options);
    }

    synthesize = mocks.synthesize;
  },
}));

import { synthesizeReplySpeech } from "./reply-speech";

test("使用完整标点文本和用户上下文生成回复语音", async () => {
  const blob = new Blob(["audio"], { type: "audio/mpeg" });
  mocks.synthesize.mockResolvedValue({
    audio: blob,
    requestId: "request-1",
    logId: "log-1",
    sessionId: "session-1",
    textWords: 12,
  });
  const log = { info: vi.fn() } as unknown as PinoLogger;

  const result = await synthesizeReplySpeech("今天很好。明天也好！", "  用户上下文。  ", log);

  expect(mocks.constructor).toHaveBeenCalledWith({
    apiKey: "f82b43fd-4cf5-423a-a54b-09303aedf3cc",
    timeoutMs: 30_000,
    resourceId: "seed-icl-2.0",
  });
  expect(mocks.synthesize).toHaveBeenCalledWith("今天很好。明天也好！", {
    speaker: "S_twakIPOe2",
    model: "seed-tts-2.0-expressive",
    toneFidelity: true,
    contextTexts: ["用户上下文。"],
    format: "mp3",
  });
  expect(result).toEqual({ type: "audio", blob });
  expect(log.info).toHaveBeenCalledWith(
    {
      requestId: "request-1",
      logId: "log-1",
      sessionId: "session-1",
      textWords: 12,
      audioBytes: blob.size,
    },
    "回复语音合成完成",
  );
});
