import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { parse, join } from "node:path";
import { tool, type ToolSet } from "ai";
import { Mutex } from "async-mutex";
import { z } from "zod";
import type { ImagePart } from "./parts";
import { blobToDataURL } from "@/utils/blob";
import { createFsFile } from "@/utils/fs-file";
import { sanitizeImagePath, virtualToRealPath } from "@/utils/image-cache";
import { dataPath } from "@/utils/path";

export const MAX_STICKERS = 30;
export const MAX_STICKER_SIZE = 10 * 1024 * 1024;

const stickersDir = dataPath("workspace", "stickers");
const stickerExtensions = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif"]);
const stickerLock = new Mutex();

type StickerFile = { filename: string; name: string; path: string };

function isStickerImage(filename: string) {
  return stickerExtensions.has(parse(filename).ext.toLowerCase());
}

function validateStickerName(name: string) {
  if (/^[\p{L}][\p{L}\p{N}_-]+$/u.test(name) && name.length >= 2 && name.length <= 32) return;
  throw new Error("贴纸名必须为 2 至 32 个字符，以字母开头，且只能包含字母、数字、下划线或连字符");
}

function validateStickerDescription(description: string) {
  const normalized = description.trim();
  if (!normalized) throw new Error("贴纸描述不能为空");
  if (normalized.length > 10_000) throw new Error("贴纸描述不能超过 10000 个字符");
  return normalized;
}

function validateExtension(extension: string) {
  if (stickerExtensions.has(extension)) return;
  throw new Error("仅支持 webp、png、jpg、jpeg 或 gif 图片");
}

async function readStickerFiles(): Promise<StickerFile[]> {
  const filenames = await readdir(stickersDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return filenames
    .filter(isStickerImage)
    .map((filename) => ({ filename, name: parse(filename).name, path: join(stickersDir, filename) }));
}

async function findStickerFile(name: string) {
  validateStickerName(name);
  return (await readStickerFiles()).find((file) => file.name === name);
}

async function createStickerFile(
  name: string,
  description: string,
  extension: string,
  writeImage: (path: string) => Promise<void>,
) {
  validateStickerName(name);
  validateExtension(extension);
  const normalizedDescription = validateStickerDescription(description);

  await mkdir(stickersDir, { recursive: true });
  const files = await readStickerFiles();
  if (files.some((file) => file.name === name))
    throw new Error(`贴纸 [${name}] 已存在，请使用其他名称或先移除现有贴纸`);
  if (files.length >= MAX_STICKERS) throw new Error(`贴纸库最多容纳 ${MAX_STICKERS} 张贴纸，请先移除不再需要的贴纸`);

  const imagePath = join(stickersDir, `${name}${extension}`);
  const descriptionPath = `${imagePath}.txt`;
  await writeFile(descriptionPath, normalizedDescription, { encoding: "utf8", flag: "wx" });
  try {
    await writeImage(imagePath);
  } catch (error) {
    await rm(descriptionPath, { force: true });
    throw error;
  }
}

async function readStickerDescription(path: string) {
  return (await readFile(`${path}.txt`, "utf8").catch(() => "")).trim();
}

export async function listStickers() {
  const files = await readStickerFiles();
  const stickers = await Promise.all(
    files.map(async ({ filename, name, path }) => {
      const [description, fileStat] = await Promise.all([readStickerDescription(path), stat(path)]);
      return { name, filename, description, size: fileStat.size, updated_at: fileStat.mtimeMs };
    }),
  );
  return stickers.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getStickerPath(name: string) {
  return (await findStickerFile(name))?.path;
}

export async function addSticker(name: string, description: string, image: File) {
  if (image.size > MAX_STICKER_SIZE) throw new Error("贴纸图片不能超过 10 MB");
  const extension = parse(image.name).ext.toLowerCase();
  await stickerLock.runExclusive(() =>
    createStickerFile(name, description, extension, async (path) => {
      await writeFile(path, new Uint8Array(await image.arrayBuffer()), { flag: "wx" });
    }),
  );
}

export async function removeSticker(name: string) {
  await stickerLock.runExclusive(async () => {
    const file = await findStickerFile(name);
    if (!file) throw new Error(`贴纸 [${name}] 不存在`);
    await Promise.all([rm(file.path), rm(`${file.path}.txt`, { force: true })]);
  });
}

export async function getStickersContext() {
  const stickers = await Promise.all(
    (await readStickerFiles()).map(async ({ name, path }) => ({
      name,
      description: await readStickerDescription(path),
    })),
  );
  stickers.sort((left, right) => left.name.localeCompare(right.name));
  const list = stickers.length
    ? stickers.map(({ name, description }) => `<sticker>\n<name>${name}</name>\n${description}\n</sticker>`).join("\n")
    : "[暂无贴纸资源]";
  const { default: stickerPrompt } = await import("./stickers.txt?raw");
  return { stickers, content: `<stickers>\n${stickerPrompt.replace("{{list}}", list)}\n</stickers>` };
}

export async function resolveSticker(name: string): Promise<ImagePart | null> {
  const file = await findStickerFile(name);
  if (!file) return null;
  const url = await createFsFile(file.path)
    .then(blobToDataURL)
    .catch(() => null);
  if (!url) return null;
  return { type: "image", raw: `[${name}]`, data: { file: url, url, sub_type: 1, summary: `[${name}]` } };
}

async function addStickerFromCache(name: string, imagePath: string, description: string) {
  const virtualPath = sanitizeImagePath(imagePath);
  const sourcePath = virtualToRealPath(virtualPath);
  const extension = parse(sourcePath).ext.toLowerCase();
  validateExtension(extension);
  const sourceStat = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!sourceStat?.isFile()) throw new Error("图片文件不存在或已失效");
  await stickerLock.runExclusive(() =>
    createStickerFile(name, description, extension, (path) => copyFile(sourcePath, path, constants.COPYFILE_EXCL)),
  );
}

function getToolError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export const stickersTools: ToolSet = {
  add_sticker: tool({
    description: "将图片缓存中的一张图片存储为贴纸。图库最多容纳 30 张贴纸。",
    inputSchema: z.object({
      name: z.string().describe("贴纸名，例如 开心、震惊、晚安"),
      image_path: z.string().describe("可用的图片绝对路径"),
      description: z.string().describe("包含语气、场景、强度、禁用场景和画面的完整描述"),
    }),
    async execute({ name, image_path, description }) {
      try {
        await addStickerFromCache(name, image_path, description);
        return `已添加贴纸 [${name}]`;
      } catch (error) {
        return getToolError(error, "添加贴纸失败");
      }
    },
  }),
  remove_sticker: tool({
    description: "移除一个贴纸。",
    inputSchema: z.object({ name: z.string().describe("要移除的现有贴纸名") }),
    async execute({ name }) {
      try {
        await removeSticker(name);
        return `已移除贴纸 [${name}]`;
      } catch (error) {
        return getToolError(error, "移除贴纸失败");
      }
    },
  }),
};
