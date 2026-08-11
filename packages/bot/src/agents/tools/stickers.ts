import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { tool } from "ai";
import { Mutex } from "async-mutex";
import { z } from "zod";
import { dataPath } from "@/utils/path";
import { sanitizeImagePath, virtualToRealPath } from "@/utils/image-cache";

export const MAX_STICKERS = 30;

const stickersDir = dataPath("workspace", "stickers");
const stickerExtensions = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif"]);
const stickerLock = new Mutex();

function validateName(name: string) {
  if (!/^[\p{L}][\p{L}\p{N}_-]+$/u.test(name) || name.length < 2 || name.length > 32) {
    throw new Error("贴纸名必须为 2 至 32 个字符，以字母开头，且只能包含字母、数字、下划线或连字符");
  }
}

export function createStickerTools() {
  return {
    add_sticker: tool({
      description: "将图片缓存中的一张图片存储为贴纸。图库最多容纳 30 张贴纸。",
      inputSchema: z.object({
        name: z.string().describe("贴纸名，例如 开心、震惊、晚安"),
        image_path: z.string().describe("可用的图片绝对路径"),
        description: z.string().describe("包含语气、场景、强度、禁用场景和画面的完整描述"),
      }),
      async execute(input) {
        return await stickerLock.runExclusive(async () => {
          validateName(input.name);
          const description = input.description.trim();
          if (!description) return "贴纸描述不能为空";

          const virtualPath = sanitizeImagePath(input.image_path);
          const path = virtualToRealPath(virtualPath);
          const extension = parse(path).ext.toLowerCase();
          if (!stickerExtensions.has(extension)) {
            return "仅支持 webp、png、jpg、jpeg 或 gif 图片";
          }

          const imageStat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (!imageStat?.isFile()) {
            return "图片文件不存在或已失效";
          }

          await mkdir(stickersDir, { recursive: true });
          const files = await readdir(stickersDir);
          const imageFiles = files.filter((file) => stickerExtensions.has(parse(file).ext.toLowerCase()));
          if (imageFiles.some((file) => parse(file).name === input.name)) {
            return `贴纸 [${input.name}] 已存在，请使用其他名称或先移除现有贴纸`;
          }
          if (imageFiles.length >= MAX_STICKERS) {
            return `贴纸库最多容纳 ${MAX_STICKERS} 张贴纸，请先移除不再需要的贴纸`;
          }

          const stickerPath = join(stickersDir, `${input.name}${extension}`);
          const descriptionPath = `${stickerPath}.txt`;
          await writeFile(descriptionPath, description, { encoding: "utf8", flag: "wx" });
          try {
            // 先保存描述，图片一旦出现就始终有可供聊天 agent 使用的说明。
            await copyFile(path, stickerPath, constants.COPYFILE_EXCL);
          } catch (error) {
            await rm(descriptionPath, { force: true });
            throw error;
          }

          return `已添加贴纸 [${input.name}]`;
        });
      },
    }),

    remove_sticker: tool({
      description: "移除一个贴纸。",
      inputSchema: z.object({
        name: z.string().describe("要移除的现有贴纸名"),
      }),
      async execute({ name }) {
        return await stickerLock.runExclusive(async () => {
          validateName(name);
          const files = await readdir(stickersDir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          const stickerFiles = files.filter(
            (file) => stickerExtensions.has(parse(file).ext.toLowerCase()) && parse(file).name === name,
          );
          if (stickerFiles.length === 0) return `贴纸 [${name}] 不存在`;

          await Promise.all(
            stickerFiles.flatMap((file) => [
              rm(join(stickersDir, file)),
              rm(join(stickersDir, `${file}.txt`), { force: true }),
            ]),
          );
          return `已移除贴纸 [${name}]`;
        });
      },
    }),
  };
}
