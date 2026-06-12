import { z } from 'zod';
import { tool } from 'ai';
import { parse, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lookup, extension } from 'mime-types';
import { download } from './utils/blob';

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
              const mime = lookup(ref);
              const mimes = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
              if (!mime || !mimes.has(mime)) {
                  return `不支持该类型的图像文件：${ref}`;
              }
              let buffer: Buffer;
              try {
                  buffer = await readFile(ref);
              } catch {
                  return `图片文件未找到: "${ref}"，可能不存在或已过期，请使用绝对文件系统路径或检查文件是否存在。`;
              }
              const filename = parse(ref).base;
              form.append("images", new Blob([buffer], { type: mime }), filename);
          }
          const response = await fetch("http://localhost:3000/generate", {
              method: "POST",
              body: form,
          });
          if (!response.ok) {
              throw new Error(`图像生成失败: ${response.status} ${await response.text()}`);
          }
          const { urls } = await response.json() as { urls: string[] };
          const dir = resolve(".cache", "images");
          await mkdir(dir, { recursive: true });
          const paths: string[] = [];
          for (const url of urls) {
              const blob = await download(url);
              const buffer = Buffer.from(await blob.bytes());
              const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 5);
              const ext = extension(blob.type) || "png";
              const filename = `${hash}.${ext}`;
              await writeFile(resolve(dir, filename), buffer);
              paths.push(`/images/${filename}`);
          }
          return `已生成 ${paths.length} 张图像，路径如下：\n${paths.join("\n")}`;
      }
  }),
}
