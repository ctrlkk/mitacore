import { writeFile } from "node:fs/promises";
import { DoubaoTtsClient } from "./tts/doubao.ts";

const apiKey = "f82b43fd-4cf5-423a-a54b-09303aedf3cc";

const client = new DoubaoTtsClient({
  apiKey,
  timeoutMs: 30_000,
  resourceId: "seed-icl-2.0",
});

try {
  const result = await client.synthesize("没关系，我已经习惯一个人了。", {
    speaker: "S_twakIPOe2",
    model: "seed-tts-2.0-expressive",
    toneFidelity: true,
    contextTexts: ["我最近心情很低落，最信任的朋友也离开了我。"],
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
