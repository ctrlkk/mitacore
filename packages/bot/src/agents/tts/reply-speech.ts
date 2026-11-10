import type { AudioPart } from "@/message/parts";
import { logger, type PinoLogger } from "@/logger";
import { DoubaoTtsClient } from "./doubao";

const client = new DoubaoTtsClient({
  apiKey: process.env.DUBAO_API_KEY || "sk-xxx",
  timeoutMs: 30_000,
  resourceId: "seed-icl-2.0",
});

/**
 * 为回复文本生成语音。
 * @param text 回复文本。
 * @param contextText 上下文文本，用于语音合成。
 * @param log 日志记录器。
 * @returns 语音音频部分。
 */
export async function synthesizeReplySpeech(
  text: string,
  contextText?: string,
  log: PinoLogger = logger,
): Promise<AudioPart> {
  const normalizedContext = contextText?.trim();
  const result = await client.synthesize(text, {
    speaker: "S_twakIPOe2",
    model: "seed-tts-2.0-expressive",
    toneFidelity: true,
    contextTexts: normalizedContext ? [normalizedContext] : undefined,
    format: "mp3",
  });

  log.info(
    {
      requestId: result.requestId,
      logId: result.logId,
      sessionId: result.sessionId,
      textWords: result.textWords,
      audioBytes: result.audio.size,
    },
    "回复语音合成完成",
  );

  return { type: "audio", blob: result.audio };
}
