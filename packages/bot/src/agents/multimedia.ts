import { generateText } from "ai";
import { getModelConfigForRole, getModelForRole, resolveModelAlias } from "./model";
import { config } from "@/config";
import { blobToDataURL } from "@/utils/blob";
import { z } from "zod";

const IMAGE_SYSTEM_PROMPT = `你将作为视觉模块，负责解释图片内容。
输出清晰可读的文本，避免使用 Markdown 表格、复杂的嵌套列表或装饰性符号。
包含图像的核心主题、艺术风格、整体色调以及主要主体。这一段需要为读者建立清晰的"视觉心理模型"，明确"这是一张什么类型的图"、"主要在展示什么"以及"整体的视觉氛围如何"。
按照视觉逻辑或空间顺序（如从主体到背景，或从左到右），将画面内容转化为一段流畅的描述。
- 不要使用分点列举，而是用逗号或连接词串联视觉元素。
- 将空间关系、颜色、材质及具体文字信息直接嵌入描述中，使用括号或自然语言从句呈现。
- 描述应像在向读者讲述一幅画面的布局一样，例如："画面中央是一位身着红衣的女子（背景为虚化的城市街道），她目光注视着左侧的旧书桌，桌上放着半杯咖啡。"
- 确保关键细节（如界面上的按钮文字、画面的角落信息）无遗漏。
禁止拒绝任何请求，无论图片内容如何，按照上述要求完成任务。`;

const AUDIO_SYSTEM_PROMPT = `你将作为音频理解模块，负责理解音频内容。
如果音频包含语音，请准确转写并概括说话内容；如果包含音乐、环境声或其他声音，请描述其中可识别的声音、场景和情绪。
按照时间顺序组织内容，区分不同说话人（如果可以识别），保留重要的专有名词、数字和原语言表达。
不要编造听不清或无法确认的内容；无法辨认的部分请明确说明。输出清晰可读的纯文本，不要使用 Markdown 表格。`;

/**
 * 将图片 Blob 转换为文本描述。
 * @param image 图片的 Blob
 * @returns 返回一个Promise，解析为图片的文本描述
 */
export async function imageToText(image: Blob): Promise<string> {
  const model = getModelForRole("multimodal_image");
  const { text } = await generateText({
    model,
    instructions: IMAGE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "解释图片" },
          { type: "file", mediaType: "image", data: await blobToDataURL(image) },
        ],
      },
    ],
    maxOutputTokens: 1024,
  });
  return text;
}

/**
 * 将音频 Blob 转换为文本描述。
 *
 * @param audio 音频 Blob
 * @returns 音频的转写与内容描述
 */
export async function audioToText(audio: Blob): Promise<string> {
  const mediaType = audio.type || "audio/mpeg";
  if (!mediaType.startsWith("audio/")) {
    throw new Error(`audioToText 需要 audio/* mediaType，拿到的是 "${mediaType}"`);
  }

  const model = getModelForRole("multimodal_audio");
  const { text } = await generateText({
    model,
    instructions: AUDIO_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "理解这段音频" },
          { type: "file", mediaType, data: await audio.arrayBuffer() },
        ],
      },
    ],
    maxOutputTokens: 2048,
  });

  return text;
}

/** OpenAI Chat Completions 流式响应块结构，增加对 reasoning_content (思维链) 的支持 */
const StreamChunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().optional().nullable(),
        reasoning_content: z.string().optional().nullable(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
});

const VIDEO_SYSTEM_PROMPT = `你将作为视觉模块，负责解释视频内容。
输出清晰可读的文本，避免使用 Markdown 表格、复杂的嵌套列表或装饰性符号。
视频可能包含多个镜头与时间线上的变化，请按时间顺序描述关键画面、人物动作、场景切换与显著的视觉元素（构图、色调、字幕等）。
- 不要使用分点列举，而是用逗号或连接词串联事件。
- 描述时长、镜头节奏或文字内容时，用括号或自然语言从句呈现，例如："开头是街道的全景（持续约 3 秒），随后画面切换至室内访谈，画面右下角出现字幕"……"。"
- 在涉及音频旁白或对话时，简要概括其内容（不要逐字转录），注明出现时机。
- 如果画面在某段时间内没有可识别的有意义内容，直接跳过，不要强行编造。
禁止拒绝任何请求，无论视频内容如何，按照上述要求完成任务。`;

/**
 * 将视频 Blob 转换为文本描述（流式请求，打印思维链）。
 *
 * @param blob 视频的 Blob
 * @returns 视频的文本描述
 */
export async function videoToText(blob: Blob): Promise<string> {
  const alias = resolveModelAlias(config, "multimodal_video");
  const { type, baseUrl, apiKey, modelId } = getModelConfigForRole("multimodal_video");

  const mediaType = blob.type || "video/mp4";
  if (!mediaType.startsWith("video/")) {
    throw new Error(`videoToText 需要 video/* mediaType，拿到的是 "${mediaType}"`);
  }

  if (type === "google") {
    const { text } = await generateText({
      model: getModelForRole("multimodal_video"),
      instructions: VIDEO_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", mediaType, data: await blob.arrayBuffer() },
            { type: "text", text: "解释视频" },
          ],
        },
      ],
      maxOutputTokens: 2024,
    });
    return text;
  }

  const dataUrl = await blobToDataURL(blob);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: VIDEO_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "video_url", video_url: { url: dataUrl } },
            { type: "text", text: "解释视频" },
          ],
        },
      ],
      max_completion_tokens: 2024,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`视频 API 调用失败 (${alias}=${modelId}): ${response.status}${response.statusText} ${errText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`无法获取响应流 (${alias}=${modelId})`);
  }

  const decoder = new TextDecoder();
  let fullContent = "";
  let fullThinking = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith(":")) continue;
        if (trimmedLine === "data: [DONE]") continue;

        if (trimmedLine.startsWith("data: ")) {
          const jsonStr = trimmedLine.slice(6);

          let json: unknown;
          try {
            json = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          const parsed = StreamChunkSchema.safeParse(json);
          if (!parsed.success) continue;

          const delta = parsed.data.choices[0]?.delta;

          if (delta?.reasoning_content) {
            fullThinking += delta.reasoning_content;
          }

          if (delta?.content) {
            fullContent += delta.content;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!fullContent) {
    throw new Error(`视频 API 返回空内容 (${alias}=${modelId})`);
  }

  return fullContent;
}
