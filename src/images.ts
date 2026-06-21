import { readFile } from "node:fs/promises";
import { resolve, parse } from "node:path";
import { marked, type Token } from "marked";
import { readdir } from "node:fs/promises";
import XMLBuilder from "fast-xml-builder";
import { sanitizeImagePath, readCachedImageAsDataUrl } from "./utils/image-cache";

interface ImagePart {
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

export type MessagePart = string | ImagePart;

// 定义极简的中间数据结构
interface SimpleNode {
  type: "text" | "image";
  text?: string;
  href?: string;
}

/**
 * 将复杂的 AST 扁平化为简单的 text/image 数组
 */
function flattenTokens(tokens: Token[]): SimpleNode[] {
  const nodes: SimpleNode[] = [];
  for (const token of tokens) {
    if (token.type === "image") {
      nodes.push({ type: "image", href: token.href, text: token.text });
    } else if ("tokens" in token && token.tokens && token.tokens.length > 0) {
      // 递归处理子节点（如段落中的加粗、列表中的文本等）
      nodes.push(...flattenTokens(token.tokens));
      // 块级元素补充换行，保持基本排版
      if (["paragraph", "heading", "blockquote", "code", "list", "table", "hr"].includes(token.type)) {
        nodes.push({ type: "text", text: "\n" });
      }
    } else {
      // 纯文本或其他无子节点的 token
      nodes.push({ type: "text", text: token.raw || "" });
    }
  }
  return nodes;
}

/**
 * 辅助函数：处理单个图片的解析与读取
 */
async function resolveImage(href: string, alt?: string): Promise<ImagePart | null> {
  // 处理贴纸
  if (href.startsWith("sticker:")) {
    let stickerId = href.slice("sticker:".length);
    if (!parse(stickerId).ext) stickerId += ".png";
    const stickerPath = resolve("references", "stickers", stickerId);
    try {
      const buffer = await readFile(stickerPath);
      const ext = parse(stickerId).ext.slice(1);
      const mime = ext === "jpg" ? "jpeg" : ext;
      const url = `data:image/${mime};base64,${buffer.toString("base64")}`;
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

  if (/^https?:\/\//i.test(href)) {
    return { type: "image", raw: `![${alt ?? ""}](${href})`, data: { file: href, url: href } };
  } else {
    const virtualPath = sanitizeImagePath(href);
    const dataUrl = await readCachedImageAsDataUrl(virtualPath);
    if (dataUrl) {
      return { type: "image", raw: `![${alt ?? ""}](${virtualPath})`, data: { file: dataUrl, url: dataUrl } };
    }
    return null;
  }
}

/**
 * 将简单数组转化为平台需要的消息数组
 */
async function convertToMessageParts(nodes: SimpleNode[]): Promise<MessagePart[]> {
  const parts: MessagePart[] = [];
  let currentText = "";

  for (const node of nodes) {
    if (node.type === "text") {
      currentText += node.text;
    } else if (node.type === "image") {
      // 遇到图片，先结算之前累积的文本
      if (currentText.trim()) {
        parts.push(currentText.trim());
        currentText = "";
      }

      const imagePart = await resolveImage(node.href!, node.text);
      if (imagePart) {
        parts.push(imagePart);
      } else {
        // 如果图片读取失败，降级为原始 markdown 文本
        currentText += `![${node.text || ""}](${node.href})`;
      }
    }
  }

  // 结算最后的文本
  if (currentText.trim()) {
    parts.push(currentText.trim());
  }

  return parts;
}

/**
 * 解析 Markdown 内容为平台需要的消息数组
 * @param content Markdown 内容
 * @returns 平台需要的消息数组
 */
export async function parseMarkdown(content: string): Promise<MessagePart[]> {
  const tokens = marked.lexer(content);
  const simpleNodes = flattenTokens(tokens);
  return convertToMessageParts(simpleNodes);
}

async function loadStickers(): Promise<{ id: string; description: string }[]> {
  const files = await readdir(resolve("references", "stickers"));
  const pngFiles = files.filter((f) => f.endsWith(".png")).sort();
  const stickers: { id: string; description: string }[] = [];

  for (const pngFile of pngFiles) {
    const baseName = parse(pngFile).name;
    try {
      const description = (await readFile(resolve("references", "stickers", `${baseName}.txt`), "utf8")).trim();
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
