import { tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { getModel, getModelForRole } from "@/agents/model";
import { blobToDataURL } from "@/utils/blob";
import { compressImage } from "@/utils/image-resize";
import creationPrompt from "@/prompts/sticker-create.txt?raw";

const suggestionSchema = z.object({
  name: z.string().min(2).max(32).describe("简短、直接表达聊天语义的贴纸名"),
  description: z.string().min(1).max(500).describe("500 字以内的贴纸使用说明"),
});

export type StickerSuggestion = z.infer<typeof suggestionSchema>;
export type StickerSuggestionEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "result"; suggestion: StickerSuggestion };

const suggestionTools = {
  submit_suggestion: tool({
    description: "提交新增贴纸表单的建议内容。必须且只能调用一次；此工具不会修改贴纸库。",
    inputSchema: suggestionSchema,
  }),
};

function createSuggestionAgent(modelAlias?: string) {
  return new ToolLoopAgent({
    model: modelAlias ? getModel(modelAlias) : getModelForRole("multimodal_image"),
    instructions: `${creationPrompt}\n\n本次任务只提供表单建议，不得修改贴纸库。分析完成后必须调用 submit_suggestion 提交结果，不要输出普通文本。`,
    tools: suggestionTools,
    toolChoice: { type: "tool", toolName: "submit_suggestion" },
    maxOutputTokens: 1024,
  });
}

export async function* streamStickerSuggestion(
  image: File,
  modelAlias?: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StickerSuggestionEvent> {
  yield { type: "status", message: "正在准备图片…" };
  const compressedImage = await compressImage(image);
  yield { type: "status", message: "正在分析图片…" };

  const result = await createSuggestionAgent(modelAlias).stream({
    abortSignal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "请根据这张图片填写新增贴纸表单。不要修改贴纸库，只返回结构化建议。",
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

  if (!submitted) throw new Error("AI 未能生成贴纸表单建议，请重试");
}
