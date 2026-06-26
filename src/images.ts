import { marked, type Token } from "marked";
import { sanitizeImagePath, readCachedImageAsDataUrl, downloadImageAsDataUrl } from "./utils/image-cache";
import { resolveStickerImage } from "./utils/stickers";

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
 * 处理单个图片的解析与读取
 */
async function resolveImage(href: string, alt?: string): Promise<ImagePart | null> {
  if (href.startsWith("sticker:")) {
    return resolveStickerImage(href, alt);
  } else if (/^https?:\/\//i.test(href)) {
    const dataUrl = await downloadImageAsDataUrl(href);
    if (dataUrl) {
      return { type: "image", raw: `![${alt ?? ""}](${href})`, data: { file: dataUrl, url: dataUrl } };
    }
    return null;
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
  type Slot = { kind: "text"; content: string } | { kind: "image"; href: string; alt?: string };
  const slots: Slot[] = [];
  let currentText = "";

  for (const node of nodes) {
    if (node.type === "text") {
      currentText += node.text;
    } else if (node.type === "image") {
      if (currentText.trim()) {
        slots.push({ kind: "text", content: currentText.trim() });
        currentText = "";
      }
      slots.push({ kind: "image", href: node.href!, alt: node.text });
    }
  }

  if (currentText.trim()) {
    slots.push({ kind: "text", content: currentText.trim() });
  }

  const resolved = await Promise.all(
    slots.map((slot) => (slot.kind === "image" ? resolveImage(slot.href, slot.alt) : null)),
  );

  return slots.map((slot, i) => {
    if (slot.kind === "text") return slot.content;
    return resolved[i] ?? `![${slot.alt || ""}](${slot.href})`;
  });
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
