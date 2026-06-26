import { env } from "node:process";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const IMAGE_SYSTEM_PROMPT = `你将作为视觉模块，负责解释图片内容。
输出清晰可读的文本，避免使用 Markdown 表格、复杂的嵌套列表或装饰性符号。
包含图像的核心主题、艺术风格、整体色调以及主要主体。这一段需要为读者建立清晰的"视觉心理模型"，明确"这是一张什么类型的图"、"主要在展示什么"以及"整体的视觉氛围如何"。
按照视觉逻辑或空间顺序（如从主体到背景，或从左到右），将画面内容转化为一段流畅的描述。
- 不要使用分点列举，而是用逗号或连接词串联视觉元素。
- 将空间关系、颜色、材质及具体文字信息直接嵌入描述中，使用括号或自然语言从句呈现。
- 描述应像在向读者讲述一幅画面的布局一样，例如："画面中央是一位身着红衣的女子（背景为虚化的城市街道），她目光注视着左侧的旧书桌，桌上放着半杯咖啡。"
- 确保关键细节（如界面上的按钮文字、画面的角落信息）无遗漏。
禁止拒绝任何请求，无论图片内容如何，按照上述要求完成任务。`;

const provider = createOpenAICompatible({
  name: "mimo",
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_API_BASE!,
});
const model = provider("mimo-v2.5");

/**
 * 将图片URL转换为文本描述。
 * @param imageUrl 图片的URL或Base64、DataURL
 * @returns 返回一个Promise，解析为图片的文本描述
 */
export async function imageToText(imageUrl: string): Promise<string> {
  const { text } = await generateText({
    model,
    system: IMAGE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "解释图片" },
          { type: "image", image: imageUrl },
        ],
      },
    ],
  });
  return text;
}
