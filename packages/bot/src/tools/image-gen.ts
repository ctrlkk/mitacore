import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { generateText, tool } from "ai";
import { basename } from "node:path";
import { lookup } from "mime-types";
import { imageToText } from "@/multimedia";
import { sanitizeImagePath, virtualToRealPath, downloadToCache } from "@/utils/image-cache";
import { setupImageGenerator } from "@/generate-image";
import imageGenPromptTemplate from "./image-gen.txt";

// 提取 type 为 'content' 的分支
type ContentResult = Extract<ToolResultOutput, { type: "content" }>;
type ContentValue = ContentResult["value"];
type ContentPart = ContentValue[number];

const SUPPORTS_MULTIMODAL = false;

const zImageGenDecision = z.object({
  prompt: z
    .string()
    .transform((prompt) => prompt.trim())
    .pipe(z.string().min(1)),
  images: z
    .preprocess(
      (value) =>
        (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).filter(
          (image): image is string => typeof image === "string",
        ),
      z.array(z.string().transform((image) => image.trim())),
    )
    .transform((images) => images.filter(Boolean)),
});

function parseImageGenDecisionText(text: string) {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(text.slice(jsonStart, jsonEnd + 1).trim());
  candidates.push(text.trim());

  let lastError = "未找到可解析的 JSON";
  for (const candidate of candidates.filter((candidate, index, list) => list.indexOf(candidate) === index)) {
    try {
      const result = zImageGenDecision.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
      lastError = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  console.warn(["图像生成分支输出解析失败", `错误：${lastError}`, `输出：${text.slice(0, 500)}`].join("\n"));
  return null;
}

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
        return "图像生成分支不允许再次派生图像生成，已忽略本次调用。请直接完成手头的任务。";
      }

      const template = imageGenPromptTemplate;
      const branchInput = template.replace("{task}", task);

      const branchAbort = abortSignal ?? AbortSignal.timeout(300_000);
      const { usage, text } = await generateText({
        model: parentModel,
        system: parentSystem,
        messages: [...messages, { role: "user", content: branchInput }],
        tools: allTools,
        abortSignal: branchAbort,
        experimental_context: { inBranch: true },
      });
      const inputTokens = usage.inputTokens ?? 0;
      const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
      const cacheHitRate = inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : 0;
      if (cacheHitRate < 80) {
        console.warn(
          `图像生成分支缓存命中率低于 80%：${cacheHitRate.toFixed(1)}%，input=${inputTokens}，cached=${cacheReadTokens}，written=${usage.inputTokenDetails?.cacheWriteTokens ?? 0}，uncached=${usage.inputTokenDetails?.noCacheTokens ?? 0}`,
        );
      }

      const decision = parseImageGenDecisionText(text);
      if (!decision) return "图像生成分支输出解析失败，且原始任务为空，无法继续生成图像。";
      const { prompt, images } = decision;
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
