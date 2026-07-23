import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { generateText, tool } from "ai";
import { basename } from "node:path";
import { lookup } from "mime-types";
import { imageToText } from "@/multimedia";
import { sanitizeImagePath, virtualToRealPath, downloadToCache } from "@/utils/image-cache";
import { getImageGenerator } from "@/generate-image";
import { logger, type PinoLogger } from "@/logger";
import imageGenPromptTemplate from "./image-gen.txt";

// 提取 type 为 'content' 的分支
type ContentResult = Extract<ToolResultOutput, { type: "content" }>;
type ContentValue = ContentResult["value"];
type ContentPart = ContentValue[number];

const SUPPORTS_MULTIMODAL = false;

function parseImageGenDecisionXml(xml: string): { prompt: string; images: string[] } | null {
  const promptMatch = xml.match(/<prompt>([\s\S]*?)<\/prompt>/i);
  if (!promptMatch || promptMatch[1] === undefined) return null;
  const prompt = promptMatch[1].trim();
  if (!prompt) return null;
  const images = [...xml.matchAll(/<image>([\s\S]*?)<\/image>/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((image) => image.length > 0);
  return { prompt, images };
}

export function imageGen(
  allTools: ToolSet,
  parentSystem: string,
  parentModel: LanguageModel,
  log: PinoLogger = logger,
) {
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

      const { usage, text } = await generateText({
        model: parentModel,
        system: parentSystem,
        messages: [...messages, { role: "user", content: branchInput }],
        tools: allTools,
        abortSignal,
        experimental_context: { inBranch: true },
      });
      const inputTokens = usage.inputTokens ?? 0;
      const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
      const cacheHitRate = inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : 0;
      if (cacheHitRate < 80) {
        log.warn(
          {
            cacheHitRate: Number(cacheHitRate.toFixed(1)),
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
            uncachedTokens: usage.inputTokenDetails?.noCacheTokens ?? 0,
          },
          "图像生成分支缓存命中率低于 80%",
        );
      }

      const decision = parseImageGenDecisionXml(text);
      if (!decision) {
        logger.warn({ error: "未匹配到 <prompt> 字段", outputPreview: text.slice(0, 500) }, "图像生成分支输出解析失败");
        return "图像生成分支输出解析失败，且原始任务为空，无法继续生成图像。";
      }
      const { prompt, images } = decision;
      log.info({ prompt, images }, "生成图像");

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

      const { generate } = await getImageGenerator();
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
      log.info({ count: results.length }, "图像已生成");
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
            log.error({ path }, "图像生成工具：对输出图片转述失败");
            return "图片转述失败";
          });
          return ["<image>", `<path>${path}</path>`, description.trim(), "</image>"].join("\n");
        }),
      );
      log.info({ count: descriptions.length }, "图像描述完成");
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
