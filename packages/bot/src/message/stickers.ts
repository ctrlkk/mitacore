import type { ImagePart } from "./parts";
import { join, parse } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dataPath } from "@/utils/path";
import { blobToDataURL } from "@/utils/blob";

const stickersDir = dataPath("workspace", "stickers");
const stickerExtensions = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif"]);
const isImageFile = (file: string) => stickerExtensions.has(parse(file).ext.toLowerCase());

async function getStickers() {
  const files = await readdir(stickersDir).catch(() => []);
  const imageFiles = files.filter(isImageFile);

  return await Promise.all(
    imageFiles.map(async (file) => {
      const name = parse(file).name;
      const description = await readFile(join(stickersDir, `${file}.txt`), "utf-8");
      return {
        name,
        description: description.trim(),
      };
    }),
  ).then((stickers) => stickers.sort((a, b) => a.name.localeCompare(b.name)));
}

export async function getStickersContext() {
  const stickers = await getStickers();
  const output = (() => {
    if (stickers.length === 0) return "[暂无贴纸资源]";
    return stickers
      .map(({ name, description }) => `<sticker>\n<name>${name}</name>\n${description}\n</sticker>`)
      .join("\n");
  })();

  const { default: stickerPrompt } = await import("./stickers.txt");
  return {
    stickers,
    content: `<stickers>\n${stickerPrompt.replace("{{list}}", output)}\n</stickers>`,
  };
}

export async function resolveSticker(name: string): Promise<ImagePart | null> {
  const file = await readdir(stickersDir)
    .then((files) => files.find((file) => isImageFile(file) && parse(file).name === name))
    .catch(() => undefined);
  if (!file) return null;

  const url = await fetch(pathToFileURL(join(stickersDir, file)))
    .then((r) => r.blob())
    .then(blobToDataURL)
    .catch(() => null);
  if (!url) return null;
  return {
    type: "image",
    raw: `[${name}]`,
    data: { file: url, url, sub_type: 1, summary: `[${name}]` },
  };
}

if (import.meta.main) {
  console.log((await getStickersContext()).content);
}
