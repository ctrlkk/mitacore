import { readFile, readdir } from "node:fs/promises";
import { resolve, parse } from "node:path";
import { lookup } from "mime-types";
import XMLBuilder from "fast-xml-builder";
import { projectPath } from "@/utils/path";

const STICKERS_DIR = projectPath("references", "stickers");

interface StickerImageResult {
  type: "image";
  raw: string;
  data: {
    file: string;
    url: string;
    sub_type?: number;
    summary?: string;
    [key: string]: unknown;
  };
}

/**
 * 解析 sticker: 协议的图片，返回 ImagePart 或 null
 */
export async function resolveStickerImage(href: string, alt?: string): Promise<StickerImageResult | null> {
  let stickerId = href.slice("sticker:".length);
  if (!parse(stickerId).ext) stickerId += ".png";
  const stickerPath = resolve(STICKERS_DIR, stickerId);
  try {
    const buffer = await readFile(stickerPath);
    const mime = lookup(stickerId) || "image/png";
    const url = `data:${mime};base64,${buffer.toString("base64")}`;
    const summary = alt ? `[${alt.slice(0, 20)}]` : undefined;
    return {
      type: "image",
      raw: `![${alt ?? ""}](${href})`,
      data: { file: url, url, sub_type: 1, summary },
    };
  } catch {
    return null;
  }
}

async function loadStickers(): Promise<{ id: string; description: string }[]> {
  const files = await readdir(STICKERS_DIR);
  const pngFiles = files.filter((f) => f.endsWith(".png")).sort();
  const stickers: { id: string; description: string }[] = [];

  for (const pngFile of pngFiles) {
    const baseName = parse(pngFile).name;
    try {
      const description = (await readFile(resolve(STICKERS_DIR, `${baseName}.txt`), "utf8")).trim();
      stickers.push({ id: baseName, description });
    } catch {}
  }

  return stickers;
}

export async function renderStickers() {
  const prompt = `你可以在回复中插入贴纸来增强情感表达，格式为标准 Markdown 图片语法：![alt](sticker:id)。
- id 从工具返回的列表中选取，例如 ![开心](sticker:01)
- alt 用简短的文字描述情绪

使用原则：
- 自然融入：贴纸应配合文字情绪，不要强行插入。
- 先匹配：如果多个关键词都合适，选择最贴切当下情绪的一个。
- 避免重复：连续多条回复中不要使用同一个 id。
- 不滥用：只有当情绪有明显起伏（开心、害羞、疲惫、困惑等）时才使用。平淡的陈述或事实回答中不要加贴纸。
- 频率控制：贴纸在对话中出现的概率需要控制在 20% 以下。

贴纸是情绪的放大器，不是必填项。当文字本身已经足够表达时，不加贴纸。\n`;
  const stickers = await loadStickers();
  const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
  return builder.build({
    stickers: {
      "#text": prompt,
      sticker: stickers.map((s) => ({ "@_id": s.id, "#text": s.description })),
    },
  });
}
