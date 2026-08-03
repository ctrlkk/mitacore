import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { generateText, tool } from "ai";
import { lookup } from "mime-types";
import { imageToText } from "@/ai/multimedia";
import { sanitizeImagePath, virtualToRealPath } from "@/utils/image-cache";
import { createFsFile, exists } from "@/utils/fs-file";
import { logger, type PinoLogger } from "@/logger";
import { logUsage } from "@/utils/format";

// 提取 type 为 'content' 的分支
type ContentResult = Extract<ToolResultOutput, { type: "content" }>;
type ContentValue = ContentResult["value"];
type ContentPart = ContentValue[number];

type ImageGenResult =
  | {
      status: "success";
      results: { path: string; image: Blob }[];
    }
  | {
      status: "failed";
      error: string;
    };

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
  const SUPPORTS_MULTIMODAL = false;

  return tool({
    description:
      "派生图像生成分支完成视觉创作。" +
      "主代理只需给出大致想要的图像内容/任务描述即可，无需编写完整绘画提示词，也无需选择参考图。" +
      "分支会继承当前对话历史、系统提示与工具，自行决定 prompt 与参考图并完成生成，返回结果摘要。",
    inputSchema: z.object({
      task: z.string().describe("对期望图像的大致任务描述：要画什么、用途或风格意向即可，无需编写完整绘画提示词"),
    }),
    execute: async ({ task }, { messages, abortSignal, context }): Promise<ImageGenResult> => {
      if (context?.inSubagent) {
        return {
          status: "failed",
          error: "图像生成分支不允许再次派生图像生成，已忽略本次调用。",
        };
      }

      const { default: template } = await import("./image-gen.txt");
      const branchInput = `<system_reminder>\n${template.trim().replace("{{task}}", task)}\n</system_reminder>`;

      // 子分支只需要知道工具能力，不能实际执行工具而偏离图像决策任务。
      const branchTools: ToolSet = Object.fromEntries(
        Object.entries(allTools).map(([name, branchTool]) => {
          const { execute: _execute, ...toolWithoutExecute } = branchTool;
          return [name, toolWithoutExecute];
        }),
      );

      const { usage, text, finalStep } = await generateText({
        model: parentModel,
        instructions: parentSystem,
        messages: [...messages, { role: "user", content: branchInput }],
        tools: branchTools,
        abortSignal,
        runtimeContext: { inSubagent: true },
        maxOutputTokens: 4096,
      });
      logUsage(log, usage);
      log.debug({ reasoningText: finalStep.reasoningText, text }, "图像生成分支输出");

      const decision = parseImageGenDecisionXml(text);
      if (!decision) {
        log.warn({ error: "未匹配到 <prompt> 字段", outputPreview: text.slice(0, 500) }, "图像生成分支输出解析失败");
        return {
          status: "failed",
          error: "图像生成分支输出解析失败，未获得可用的图像生成决策。",
        };
      }
      const { prompt, images } = decision;
      log.info({ prompt, images }, "生成图像");

      try {
        const files = await Promise.all(
          images.map(async (ref) => {
            const filePath = virtualToRealPath(sanitizeImagePath(ref));
            const mime = lookup(filePath);
            if (!mime || !["image/jpeg", "image/png", "image/webp", "image/bmp"].includes(mime)) {
              throw new Error(`不支持该类型的图像文件：${ref}`);
            }
            if (!(await exists(filePath))) {
              throw new Error(`图片文件未找到: "${ref}"，可能不存在或已过期，请检查文件是否存在。`);
            }
            return createFsFile(filePath);
          }),
        );

        return { status: "failed", error: "暂时不支持图像生成功能。" };
        // const { generate } = await getImageGenerator();
        // const urls = await generate(prompt, files);
        // const results = await Promise.all(
        //   urls.map(async (url) => {
        //     const { virtualPath, realPath } = await downloadToCache(url);
        //     return {
        //       path: virtualPath,
        //       image: await compressImage(await createFsFile(realPath)),
        //     };
        //   }),
        // );
        // log.info({ count: results.length }, "图像已生成");
        // return { status: "success", results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ error, prompt, images }, "图像生成失败");
        return { status: "failed", error: message };
      }
    },
    async toModelOutput({ output }): Promise<ToolResultOutput> {
      if (output.status === "failed") {
        return {
          type: "content",
          value: [{ type: "text", text: `图像生成失败：${output.error}` }],
        };
      }
      if (SUPPORTS_MULTIMODAL) {
        const value: ContentPart[] = await Promise.all(
          output.results.flatMap(async ({ path, image }, index): Promise<ContentPart[]> => {
            const buffer = await image.bytes();
            return [
              { type: "text", text: `#${index} 图片路径：${path}` },
              { type: "image-data", data: buffer.toBase64(), mediaType: image.type },
            ];
          }),
        ).then((parts) => parts.flat());
        value.unshift({
          type: "text",
          text: `图片生成成功，一共${output.results.length}张，下面是图片预览；`,
        });
        return {
          type: "content",
          value,
        };
      }
      const descriptions = await Promise.all(
        output.results.map(async ({ path, image }) => {
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
