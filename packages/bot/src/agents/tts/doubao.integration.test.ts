import { describe, expect, test } from "vitest";
import { DoubaoTtsClient, DoubaoTtsModelSchema } from "./doubao";

const enabled = process.env.DOUBAO_TTS_INTEGRATION === "1";
const apiKey = process.env.DOUBAO_TTS_API_KEY;
const speaker = process.env.DOUBAO_TTS_SPEAKER;
const resourceId = process.env.DOUBAO_TTS_RESOURCE_ID;
const model = process.env.DOUBAO_TTS_MODEL;

describe.skipIf(!enabled)("DoubaoTtsClient integration", () => {
  test("通过同一条真实 V3 WebSocket 连续合成音频", async () => {
    if (!apiKey) throw new Error("缺少 DOUBAO_TTS_API_KEY");
    if (!speaker) throw new Error("缺少 DOUBAO_TTS_SPEAKER");
    const synthesisModel = DoubaoTtsModelSchema.optional().parse(model);

    const client = new DoubaoTtsClient({ apiKey, resourceId, timeoutMs: 30_000 });
    const texts = resourceId?.startsWith("seed-icl-")
      ? (["こんにちは、音声合成のテストです。", "同じ接続を再利用しています。"] as const)
      : (["你好，这是一段豆包语音合成测试。", "现在测试复用同一条连接。"] as const);
    try {
      for (const text of texts) {
        const result = await client.synthesize(text, { speaker, model: synthesisModel, format: "mp3" });
        expect(result.audio.type).toBe("audio/mpeg");
        expect(result.audio.size).toBeGreaterThan(0);
        expect(result.sessionId).toBeTruthy();
      }
    } finally {
      client.close();
    }
  });
});
