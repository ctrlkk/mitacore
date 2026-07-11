import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { generateText, tool, Output, stepCountIs, jsonSchema } from "ai";
import { basename } from "node:path";
import { lookup } from "mime-types";
import { imageToText } from "@/multimedia";
import { sanitizeImagePath, virtualToRealPath, downloadToCache } from "@/utils/image-cache";
import { setupImageGenerator } from "@/generate-image";

// 提取 type 为 'content' 的分支
type ContentResult = Extract<ToolResultOutput, { type: "content" }>;
type ContentValue = ContentResult["value"];
type ContentPart = ContentValue[number];

const SUPPORTS_MULTIMODAL = false;

/** 子代理最终输出的 JSON Schema（同时写入 prompt 与 Output.object） */
const imageGenJsonSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "用于生成图像的完整提示词，应具体、可直接交给绘图模型",
    },
    images: {
      type: "array",
      items: { type: "string" },
      description: "可选的参考图路径（绝对路径或对话中出现的本地路径），无参考图时为空数组",
      default: [],
    },
  },
  required: ["prompt", "images"],
  additionalProperties: false,
} as const;

type ImageGenDecision = {
  prompt: string;
  images: string[];
};

const imageGenOutputSchema = jsonSchema<ImageGenDecision>(imageGenJsonSchema, {
  validate: (value) => {
    const parsed = z
      .object({
        prompt: z.string().min(1),
        images: z.array(z.string()).default([]),
      })
      .safeParse(value);
    if (!parsed.success) return { success: false as const, error: parsed.error };
    return { success: true as const, value: parsed.data };
  },
});

// 懒加载 sidecar：只在首次 execute 时才启动浏览器（~10s），之后复用同一实例；
// 子进程随父进程退出经 Windows Job Object 自动回收
let generatorPromise: Promise<Awaited<ReturnType<typeof setupImageGenerator>>> | null = null;

export function imageGen(allTools: ToolSet, parentSystem: string, parentModel: LanguageModel) {
  return tool({
    description:
      "派生图像生成分支完成视觉创作。" +
      "主代理只需给出大致想要的图像内容/任务描述即可，无需编写完整绘画提示词，也无需选择参考图。" +
      "分支会继承当前对话历史、系统提示与工具，自行决定 prompt 与参考图并完成生成，返回结果摘要。",
    inputSchema: z.object({
      task: z.string().describe("对期望图像的大致任务描述：要画什么、用途或风格意向即可，无需编写完整绘画提示词"),
    }),
    execute: async ({ task }, { messages, abortSignal, experimental_context }) => {
      const inBranch = (experimental_context as { inBranch?: boolean } | undefined)?.inBranch === true;
      if (inBranch) {
        return "[image_gen] 图像生成分支不允许再次派生图像生成，已忽略本次调用。请直接完成手头的任务。";
      }

      const branchInput = [
        `<image_gen_task>`,
        task,
        ``,
        `[身份] 你是当前对话派生出的图像生成分支代理，请独立完成本次视觉创作准备。`,
        `[目标] 结合对话上下文与任务描述，确定最终用于图像生成的 prompt，以及可选的参考图路径列表。`,
        `[输出] 最终必须输出且仅输出一个符合下列 JSON Schema 的 JSON 对象（不要附加解释、不要用 markdown 代码围栏包裹）：`,
        JSON.stringify(imageGenJsonSchema, null, 2),
        `[约束] 你不能再调用 image_gen 工具派生下一层分支。`,
        `</image_gen_task>`,
      ].join("\n");

      const branchAbort = abortSignal ?? AbortSignal.timeout(300_000);
      const { output } = await generateText({
        model: parentModel,
        system: parentSystem,
        messages: [...messages, { role: "user", content: branchInput }],
        tools: allTools,
        abortSignal: branchAbort,
        experimental_context: { inBranch: true },
        stopWhen: stepCountIs(5),
        output: Output.object({
          name: "image_gen_decision",
          description: "图像生成决策：完整 prompt 与可选参考图路径",
          schema: imageGenOutputSchema,
        }),
      });

      if (!output?.prompt?.trim()) {
        return "图像生成分支未能产出有效的 prompt，请重试或调整任务描述。";
      }

      const prompt = output.prompt.trim();
      const images = output.images ?? [];
      console.log("生成图像：" + prompt + "，参考图：" + images.join(","));

      const files: File[] = [];
      for (const ref of images) {
        const filePath = virtualToRealPath(sanitizeImagePath(ref));
        const mime = lookup(filePath);
        if (!mime || !["image/jpeg", "image/png", "image/webp", "image/bmp"].includes(mime)) {
          return `不支持该类型的图像文件：${ref}`;
        }
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return `图片文件未找到: "${ref}"，可能不存在或已过期，请检查文件是否存在。`;
        }
        files.push(new File([file], basename(filePath), { type: mime }));
      }

      const { generate } = await (generatorPromise ??= setupImageGenerator());
      const urls = await generate(prompt, files);

      const results = await Promise.all(
        urls.map(async (url) => {
          const { virtualPath, realPath } = await downloadToCache(url);
          const file = Bun.file(realPath);
          return {
            path: virtualPath,
            image: await new Bun.Image(file).webp({ quality: 80 }).blob(),
          };
        }),
      );
      console.log("图像已生成");
      return results;
    },
    async toModelOutput({ output }): Promise<ToolResultOutput> {
      if (typeof output === "string") {
        return {
          type: "content",
          value: [{ type: "text", text: output }],
        };
      }
      if (SUPPORTS_MULTIMODAL) {
        const value: ContentPart[] = await Promise.all(
          output.flatMap(async ({ path, image }, index): Promise<ContentPart[]> => {
            const buffer = await image.bytes();
            return [
              { type: "text", text: `#${index} 图片路径：${path}` },
              { type: "image-data", data: buffer.toBase64(), mediaType: image.type },
            ];
          }),
        ).then((parts) => parts.flat());
        value.unshift({ type: "text", text: `图片生成成功，一共${output.length}张，下面是图片预览；` });
        return {
          type: "content",
          value,
        };
      }
      const descriptions = await Promise.all(
        output.map(async ({ path, image }) => {
          const description = await imageToText(image).catch(() => {
            console.error("图像生成工具：对输出图片转述失败", path);
            return "图片转述失败";
          });
          return ["<image>", `<path>${path}</path>`, description.trim(), "</image>"].join("\n");
        }),
      );
      console.log("图像描述完成");
      return {
        type: "content",
        value: [
          {
            type: "text",
            text: [`图像生成成功，一共${descriptions.length}张，下面是图片预览；`, descriptions.join("\n")].join("\n"),
          },
        ],
      };
    },
  });
}
