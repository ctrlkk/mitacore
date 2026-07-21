import { join, parse } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { projectPath } from "./utils/path";
import { blobToDataURL } from "./utils/blob";
import type { ImagePart } from "./images";

const stickersDir = projectPath("references", "stickers");

async function getStickers() {
  const files = await readdir(stickersDir);
  const webpFiles = files.filter((f) => f.endsWith(".webp") && !f.endsWith(".webp.txt"));

  return await Promise.all(
    webpFiles.map(async (file) => {
      const name = parse(file).name;
      const description = await readFile(join(stickersDir, `${name}.webp.txt`), "utf-8");
      return {
        name,
        description: description.trim(),
      };
    }),
  ).then((stickers) => stickers.sort((a, b) => a.name.localeCompare(b.name)));
}

export async function getStickersPrompt() {
  const stickers = await getStickers();
  const output = stickers
    .map(({ name, description }) => {
      return (
        `<sticker>\n` +
        `  <name>${name}</name>\n` +
        `  <description>\n` +
        `    ${description}\n` +
        `  </description>\n` +
        `</sticker>`
      );
    })
    .join("\n");

  const prompt =
    "<stickers>\n" +
    "你可以在回复中插入贴纸来增强情感表达，格式 [name] ，name 从工具返回的列表中选取，例如 [开心]\n" +
    "使用原则：\n" +
    "- 自然融入：贴纸应配合文字情绪，不要强行插入。\n" +
    "- 先匹配：如果多个关键词都合适，选择最贴切当下情绪的一个。\n" +
    "- 避免重复：连续多条回复中不要使用同一个 id。\n" +
    "- 不滥用：只有当情绪有明显起伏（开心、害羞、疲惫、困惑等）时才使用。平淡的陈述或事实回答中不要加贴纸。\n" +
    "- 频率控制：使用之前应当查看历史对话中是否已经多次使用，频率控制在20%以下为最佳，“一图胜千言”。\n\n" +
    "从下面选择合适的 sticker\n" +
    `${output}\n` +
    "</stickers>\n";

  return prompt;
}

export async function resolveSticker(name: string): Promise<ImagePart | null> {
  const url = await fetch(pathToFileURL(join(stickersDir, `${name}.webp`)))
    .then((r) => r.blob())
    .then(blobToDataURL)
    .catch(() => null);
  if (!url) return null;
  return {
    type: "image",
    raw: `[${name}]`,
    data: { file: url, url, sub_type: 1, summary: name },
  };
}

if (import.meta.main) {
  const prompt = await getStickersPrompt();
  console.log(prompt);
}
