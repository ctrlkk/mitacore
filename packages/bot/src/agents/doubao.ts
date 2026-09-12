import { writeFile } from "node:fs/promises";
import { DoubaoTtsClient } from "./tts/doubao.ts";

const apiKey = "f82b43fd-4cf5-423a-a54b-09303aedf3cc";
if (!apiKey) throw new Error("缺少 DOUBAO_TTS_API_KEY");

const client = new DoubaoTtsClient({
  apiKey,
  timeoutMs: 30_000,
  resourceId: "seed-icl-2.0",
});

try {
  const result = await client.synthesize("你好，这是一段豆包语音合成测试。", {
    speaker: "S_twakIPOe2",
    model: "seed-tts-2.0-standard",
    toneFidelity: true,
    onAudioChunk(chunk) {
      console.log(`收到音频分片：${chunk.byteLength} bytes`);
    },
  });

  await writeFile("doubao-test.mp3", new Uint8Array(await result.audio.arrayBuffer()));

  console.log({
    requestId: result.requestId,
    logId: result.logId,
    sessionId: result.sessionId,
    textWords: result.textWords,
    audioBytes: result.audio.size,
  });
} finally {
  client.close();
}
