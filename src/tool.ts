import { z } from "zod";
import { tool } from "ai";
import { parse, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { lookup, extension } from "mime-types";
import { download } from "./utils/blob";
import { imageToText } from "./multimedia";
import bs58 from "bs58";

const SUPPORTS_MULTIMODAL = false;

interface GeneratedImage {
  path: string;
  base64: string;
  mediaType: string;
}

export default {
  ImageGeneration: tool({
    description: "根据输入的描述生成图像，当需要视觉内容创作时使用。",
    inputSchema: z.object({
      prompt: z.string().describe("用于生成图像的提示词内容"),
      images: z.array(z.string()).describe("可选的用于图像生成的参考图，必须是绝对文件系统路径").default([]),
    }),
    execute: async ({ prompt, images }) => {
      const form = new FormData();
      form.append("prompt", prompt);
      for (const ref of images) {
        const filePath = ref.startsWith("/images/") ? resolve(".cache", ref.slice(1)) : ref;
        const mime = lookup(filePath);
        const mimes = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
        if (!mime || !mimes.has(mime)) {
          return `不支持该类型的图像文件：${ref}`;
        }
        let buffer: Buffer;
        try {
          buffer = await readFile(filePath);
        } catch {
          return `图片文件未找到: "${ref}"，可能不存在或已过期，请使用绝对文件系统路径或检查文件是否存在。`;
        }
        const filename = parse(filePath).base;
        form.append("images", new Blob([buffer], { type: mime }), filename);
      }
      const response = await fetch("http://localhost:3000/generate", {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new Error(`图像生成失败: ${response.status} ${await response.text()}`);
      }
      const { urls } = (await response.json()) as { urls: string[] };
      const dir = resolve(".cache", "images");
      await mkdir(dir, { recursive: true });
      const results: GeneratedImage[] = [];
      for (const url of urls) {
        const blob = await download(url);
        const buffer = Buffer.from(await blob.bytes());
        const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
        const encoded = bs58.encode(Buffer.from(hash, "hex"));
        const ext = extension(blob.type) || "png";
        const filename = `${encoded}.${ext}`;
        await writeFile(resolve(dir, filename), buffer);
        results.push({
          path: `/images/${filename}`,
          base64: buffer.toString("base64"),
          mediaType: blob.type || "image/png",
        });
      }
      console.log("图像已生成");
      return results;
    },
    async toModelOutput({ output }) {
      if (typeof output === "string") {
        return {
          type: "content",
          value: [{ type: "text", text: output }],
        };
      }
      if (SUPPORTS_MULTIMODAL) {
        return {
          type: "content",
          value: output.flatMap((r) => [
            { type: "text", text: `生成的图片: ${r.path}` },
            { type: "media", data: r.base64, mediaType: r.mediaType },
          ]),
        };
      }
      console.log("开始描述图像");
      const descriptions = await Promise.all(
        output.map(async (r) => {
          try {
            const dataUrl = `data:${r.mediaType};base64,${r.base64}`;
            const description = await imageToText(dataUrl);
            return `  <image path="${r.path}">\n${description.trim()}\n</image>`;
          } catch (e) {
            console.error(`图片转述失败: ${r.path}`, e);
            return `  <image path="${r.path}">[图片转述失败]</image>`;
          }
        }),
      );
      console.log("图像描述完成");
      return {
        type: "content",
        value: [
          {
            type: "text",
            text: `<generated_images>\n${descriptions.join("\n")}\n</generated_images>`,
          },
        ],
      };
    },
  }),
  ReadImage: tool({
    description:
      "读取一张图片并获取其内容描述。仅在上下文中出现不明图片、需要了解图片内容时使用。" +
      "这种情况通常发生在：图片信息因上下文增长而被移除，或需要重新查看某张图片的内容时。" +
      "未发生这种情况的时候请不要使用该工具。",
    inputSchema: z.object({
      path: z.string().describe("图片的路径，可以是绝对文件系统路径或 /images/ 开头的缓存路径"),
    }),
    execute: async ({ path: imagePath }) => {
      const filePath = imagePath.startsWith("/images/") ? resolve(".cache", imagePath.slice(1)) : imagePath;
      const mime = lookup(filePath);
      const mimes = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif"]);
      if (!mime || !mimes.has(mime)) {
        return `不支持该类型的图像文件：${imagePath}`;
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(filePath);
      } catch {
        return `图片文件未找到: "${imagePath}"，可能不存在或已过期，请使用绝对文件系统路径或检查文件是否存在。`;
      }
      return {
        path: imagePath,
        base64: buffer.toString("base64"),
        mediaType: mime,
      };
    },
    async toModelOutput({ output }) {
      if (typeof output === "string") {
        return {
          type: "content",
          value: [{ type: "text", text: output }],
        };
      }
      if (SUPPORTS_MULTIMODAL) {
        return {
          type: "content",
          value: [
            { type: "text", text: `图片内容: ${output.path}` },
            { type: "media", data: output.base64, mediaType: output.mediaType },
          ],
        };
      }
      const dataUrl = `data:${output.mediaType};base64,${output.base64}`;
      try {
        const description = await imageToText(dataUrl);
        return {
          type: "content",
          value: [
            {
              type: "text",
              text: `<image path="${output.path}">\n${description.trim()}\n</image>`,
            },
          ],
        };
      } catch (e) {
        console.error(`图片转述失败: ${output.path}`, e);
        return {
          type: "content",
          value: [{ type: "text", text: `图片转述失败: ${output.path}` }],
        };
      }
    },
  }),
  queryMemory: tool({
    description: "发起一个子任务来查询记忆系统中存储的记忆信息，允许通过口语化的方式来指派一个特定任务。",
    inputSchema: z.object({
      prompt: z.string().describe("用于查询记忆的提示词内容"),
    }),
    execute: async ({ prompt }) => {
      return "还未实现哦~";
    },
  }),
};
