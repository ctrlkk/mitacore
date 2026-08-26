import { streamText } from "ai";
import { getModel, getModelForRole } from "@/agents/model";
import { blobToDataURL } from "@/utils/blob";

const stickerSuggestionInstructions = `你是新增贴纸表单的填写助手。用户已经决定将当前图片加入贴纸图库；你的任务仅根据图片内容，为其生成一个贴纸名称和一份使用描述。

把贴纸视为聊天中的非语言动作。优先判断它在上下文中替用户表达什么，而不是机械描述图片画面。不得仅根据原始文件名判断含义。

命名要求：
- 名称直接表达贴纸在聊天中传达的核心语气、动作或意图，例如“笑死”“错愕”“沉思”“晚安”“探头”。
- 名称简短、自然、可区分，使用 2 至 12 个汉字；可包含字母、数字、下划线和连字符。
- 不使用人物名、作品名、原始文件名、文件序号，或过度具体的画面描述。
- 不要把相近但不同的情绪混为一谈。例如区分：轻度惊讶与突发错愕、沉思与犹豫、满足式得意与神气式邀功、困倦与晚安。

描述要求：
- 描述重点是：这张贴纸在聊天中替用户表达什么。
- 必须包含：核心语气、适用场景、表达强度、不适用场景、口语关键词。
- 仅在有助于辨别含义时补充简短画面信息。
- 适用场景应使用真实聊天语境，而不是笼统地写“表达某种情绪”。
- 明确易误用的边界。贴纸不应用于真实紧急求助、严肃冲突，或替代必要的信息表达。
- 描述简洁、准确，不超过 500 字。

分析完成后，通过标准的XML格式输出结果：
<sticker_suggestion>
  <name>贴纸名称</name>
  <description>贴纸使用说明</description>
</sticker_suggestion>`;

type StickerFormSuggestion = {
  name: string;
  description: string;
};
type StickerSuggestionStreamEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "result"; suggestion: StickerFormSuggestion };

function parseStickerSuggestionXml(xml: string): StickerFormSuggestion {
  const name = xml.match(/<name>([\s\S]*?)<\/name>/)?.[1];
  const description = xml.match(/<description>([\s\S]*?)<\/description>/)?.[1];
  if (name === undefined || description === undefined) {
    return { name: "", description: xml };
  }

  return { name: name.trim(), description: description.trim() };
}

export async function* streamStickerFormSuggestion(
  image: File,
  modelAlias?: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StickerSuggestionStreamEvent> {
  yield { type: "status", message: "正在准备图片…" };
  yield { type: "status", message: "正在分析图片…" };

  const suggestionStream = streamText({
    model: modelAlias ? getModel(modelAlias) : getModelForRole("multimodal_image"),
    instructions: stickerSuggestionInstructions,
    abortSignal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "请根据这张图片填写新增贴纸表单，只返回指定的 XML 结构。",
          },
          {
            type: "file",
            mediaType: image.type || "image/png",
            data: await blobToDataURL(image),
          },
        ],
      },
    ],
  });

  let responseXml = "";
  let hasStartedResponse = false;
  for await (const part of suggestionStream.stream) {
    if (part.type === "reasoning-delta") {
      yield { type: "reasoning", delta: part.text };
    } else if (part.type === "text-delta") {
      if (!hasStartedResponse) {
        hasStartedResponse = true;
        yield { type: "status", message: "正在整理名称与使用描述…" };
      }
      responseXml += part.text;
    } else if (part.type === "error") {
      throw part.error;
    }
  }

  if (!responseXml.trim()) throw new Error("AI 未能生成贴纸表单建议，请重试");
  yield {
    type: "result",
    suggestion: parseStickerSuggestionXml(responseXml),
  };
}
