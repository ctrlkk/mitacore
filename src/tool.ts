import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { tool } from "ai";
import { basename } from "node:path";
import { lookup } from "mime-types";
import { imageToText } from "./multimedia";
import { sanitizeImagePath, virtualToRealPath, downloadToCache } from "./utils/image-cache";
import { setupImageGenerator } from "./generate-image";

// 提取 type 为 'content' 的分支
type ContentResult = Extract<ToolResultOutput, { type: "content" }>;
type ContentValue = ContentResult["value"];
type ContentPart = ContentValue[number];

const SUPPORTS_MULTIMODAL = false;

// 懒加载 sidecar：只在首次 execute 时才启动浏览器（~10s），之后复用同一实例；
// 子进程随父进程退出经 Windows Job Object 自动回收
let generatorPromise: Promise<Awaited<ReturnType<typeof setupImageGenerator>>> | null = null;

const ImageGeneration = tool({
  description: "根据输入的描述生成图像，当需要视觉内容创作时使用。",
  inputSchema: z.object({
    prompt: z.string().describe("用于生成图像的提示词内容"),
    images: z.array(z.string()).describe("可选的用于图像生成的参考图，必须是绝对文件系统路径").default([]),
  }),
  execute: async ({ prompt, images }) => {
    const files: File[] = [];
    for (const ref of images) {
      const filePath = virtualToRealPath(sanitizeImagePath(ref));
      const mime = lookup(filePath);
      if (!mime || !["image/jpeg", "image/png", "image/webp", "image/bmp"].includes(mime)) {
        return `不支持该类型的图像文件：${ref}`;
      }
      const file = Bun.file(filePath);
      if (!file.exists()) {
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
          mediaType: "image/webp",
          base64: await new Bun.Image(file).webp({ quality: 80 }).toBase64(),
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
      const value: ContentPart[] = output.flatMap((r, index) => [
        { type: "text", text: `#${index} 图片路径：${r.path}` },
        { type: "image-data", data: r.base64, mediaType: r.mediaType },
      ]);
      value.unshift({ type: "text", text: `图片生成成功，一共${output.length}张，下面是图片预览；` });
      return {
        type: "content",
        value,
      };
    }
    const descriptions = await Promise.all(
      output.map(async (r) => {
        const dataUrl = `data:${r.mediaType};base64,${r.base64}`;
        const description = await imageToText(dataUrl).catch(() => "图片转述失败");
        return ["<image>", `<path>${r.path}</path>`, description.trim(), "</image>"].join("\n");
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

export { ImageGeneration };
