import { tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { getModel } from "@/ai/model";
import { config } from "@/config";
import { getStickersContext } from "@/message/stickers";
import { blobToDataURL } from "@/utils/blob";
import { compressImage } from "@/utils/image-resize";
import systemPrompt from "@/prompts/sticker-review.txt";

const suggestionSchema = z.object({
  suitable: z.boolean().describe("候选图片是否值得作为聊天贴纸加入图库"),
  name: z.string().max(32).describe("简短、唯一且直接表达聊天语义的贴纸名；不适合时返回空字符串"),
  description: z.string().max(500).describe("500 字以内的使用说明；不适合时返回空字符串"),
  reason: z.string().max(500).describe("候选与现有贴纸的关系及建议理由"),
});

export type StickerSuggestion = z.infer<typeof suggestionSchema>;
export type StickerSuggestionEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "result"; suggestion: StickerSuggestion };

const suggestionTools = {
  submit_suggestion: tool({
    description: "提交贴纸候选的最终分析结果。必须且只能调用一次；此工具不会修改贴纸库。",
    inputSchema: suggestionSchema,
  }),
};

function createSuggestionAgent(modelAlias: string) {
  return new ToolLoopAgent({
    model: getModel(modelAlias),
    instructions: `${systemPrompt}\n\n本次任务只提供建议，不得修改贴纸库。分析完成后必须调用 submit_suggestion 提交结果，不要输出普通文本。`,
    tools: suggestionTools,
    toolChoice: { type: "tool", toolName: "submit_suggestion" },
    maxOutputTokens: 1024,
  });
}

export async function* streamStickerSuggestion(
  image: File,
  modelAlias = config.models.multimodal_image,
  abortSignal?: AbortSignal,
): AsyncGenerator<StickerSuggestionEvent> {
  yield { type: "status", message: "正在准备图片…" };
  const [compressedImage, stickersContext] = await Promise.all([compressImage(image), getStickersContext()]);
  yield { type: "status", message: "正在分析图片与现有贴纸…" };

  const result = await createSuggestionAgent(modelAlias).stream({
    abortSignal,
    messages: [
      { role: "user", content: stickersContext.content },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "分析这张候选图片并辅助填写新增贴纸表单。不要修改贴纸库，只返回结构化建议。",
          },
          {
            type: "file",
            mediaType: compressedImage.type || "image/png",
            data: await blobToDataURL(compressedImage),
          },
        ],
      },
    ],
  });

  let submitted = false;
  for await (const part of result.stream) {
    if (part.type === "reasoning-delta") {
      yield { type: "reasoning", delta: part.text };
    } else if (part.type === "tool-input-start" && part.toolName === "submit_suggestion") {
      yield { type: "status", message: "正在整理名称与使用描述…" };
    } else if (part.type === "tool-call" && part.toolName === "submit_suggestion") {
      submitted = true;
      yield { type: "result", suggestion: suggestionSchema.parse(part.input) };
    } else if (part.type === "error") {
      throw part.error;
    }
  }

  if (!submitted) throw new Error("AI 未能生成贴纸建议，请重试");
}
