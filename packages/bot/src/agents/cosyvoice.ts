import { z } from "zod";

const DEFAULT_MODEL = "cosyvoice-v3.5-plus";

type AudioFormat = "mp3" | "pcm" | "wav" | "opus";

export interface CosyVoiceTtsOptions {
  apiKey: string;
  workspaceId: string;
  voiceId: string;
  model?: string;
  languageHints?: string[];
  instruction?: string;
  format?: AudioFormat;
  sampleRate?: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  volume?: number;
  rate?: number;
  pitch?: number;
  seed?: number;
  enableSsml?: boolean;
}

export interface CosyVoiceTtsResult {
  audio: Blob;
  requestId?: string;
  characters?: number;
}

const CosyVoiceResponseSchema = z.object({
  request_id: z.string().optional(),
  usage: z.object({ characters: z.number().int().nonnegative().optional() }).optional(),
  output: z.object({ audio: z.object({ url: z.string().url() }) }),
});

const CosyVoiceErrorResponseSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

/**
 * 调用百炼 CosyVoice 非流式接口生成完整音频。
 *
 * 自定义音色按业务空间隔离，因此请求必须使用创建音色时相同的 Workspace ID 域名；
 * 使用公共 dashscope 域名可能无法访问预期的复刻音色。
 */
export async function synthesizeCosyVoice(text: string, options: CosyVoiceTtsOptions): Promise<CosyVoiceTtsResult> {
  if (!text.trim()) throw new Error("CosyVoice 待合成文本不能为空");
  if (!/^[a-z0-9-]+$/.test(options.workspaceId)) throw new Error("CosyVoice Workspace ID 格式无效");
  if (!options.apiKey) throw new Error("CosyVoice API Key 不能为空");
  if (!options.voiceId) throw new Error("CosyVoice 音色 ID 不能为空");

  const format = options.format ?? "mp3";
  const response = await fetch(
    `https://${options.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        input: {
          text,
          voice: options.voiceId,
          format,
          ...(options.languageHints ? { language_hints: options.languageHints } : {}),
          ...(options.instruction ? { instruction: options.instruction } : {}),
          ...(options.sampleRate ? { sample_rate: options.sampleRate } : {}),
          ...(options.volume !== undefined ? { volume: options.volume } : {}),
          ...(options.rate !== undefined ? { rate: options.rate } : {}),
          ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          ...(options.enableSsml ? { enable_ssml: true } : {}),
        },
      }),
    },
  );

  if (!response.ok) {
    const result = CosyVoiceErrorResponseSchema.parse(await response.json());
    throw new Error(`CosyVoice 合成失败：${result.code ?? response.status} ${result.message ?? ""}`);
  }

  const result = CosyVoiceResponseSchema.parse(await response.json());

  // 非流式接口返回的是短期有效 URL，而非音频字节；在此下载后再交由渠道层发送。
  const audioResponse = await fetch(result.output.audio.url);
  if (!audioResponse.ok) throw new Error(`下载 CosyVoice 音频失败：${audioResponse.status}`);

  return {
    audio: await audioResponse.blob(),
    requestId: result.request_id,
    characters: result.usage?.characters,
  };
}
