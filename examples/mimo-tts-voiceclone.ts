import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { env } from "node:process";

type MiMoTtsResponse = {
  choices: Array<{
    message: {
      audio: {
        data: string;
      };
    };
  }>;
};

const voiceBase64 = await readFile("voice-samples/senko-sp01-vocals-reference.wav", "base64");
const voice = `data:audio/wav;base64,${voiceBase64}`;

const response = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "api-key": env.MIMO_API_KEY!,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "mimo-v2.5-tts-voiceclone",
    messages: [
      {
        role: "assistant",
        content: `（惊吓）萝莉控！`,
      },
    ],
    audio: {
      format: "wav",
      voice,
    },
  }),
});

const result = (await response.json()) as MiMoTtsResponse;
const audioBase64 = result.choices[0]!.message.audio.data;

await mkdir(".cache", { recursive: true });
await Bun.write(".cache/mimo-voiceclone-children-day.wav", Buffer.from(audioBase64, "base64"));
console.log("Audio saved to .cache/mimo-voiceclone-children-day.wav");
