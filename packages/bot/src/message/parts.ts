import { marked, type Token } from "marked";
import { sanitizeImagePath, virtualToRealPath } from "../utils/image-cache";
import { blobToDataURL, download } from "../utils/blob";
import { pathToFileURL } from "node:url";
import { resolveSticker } from "./stickers";

export interface ImagePart {
  type: "image";
  raw: string;
  data: {
    file: string;
    url: string;
    // 图片类型，0 表示普通图片，1 表示 sticker
    sub_type?: number;
    summary?: string;
    [key: string]: unknown;
  };
}

export interface AudioPart {
  type: "audio";
  blob: Blob;
}

export type MessagePart = string | ImagePart | AudioPart;

export interface ReplyOutput {
  /** 用于按聊天节奏逐条发送的消息片段。 */
  segments: MessagePart[];
  /** 清理旁白后、保留完整标点的可朗读文本。 */
  speechText: string;
}

type MediaReference =
  | {
      type: "image-reference";
      href: string;
      text: string;
      raw: string;
    }
  | {
      type: "sticker-reference";
      text: string;
      raw: string;
    };

export type ParsedMessagePart = string | MediaReference;

/**
 * 注册自定义的 sticker 扩展，用于解析 [name] 格式的的 sticker 图片
 */
marked.use({
  extensions: [
    {
      name: "sticker",
      level: "inline",
      // 标记下一个潜在匹配位置，防止 lexer 跳过含 [ 的文本段
      start(src: string) {
        return src.indexOf("[");
      },
      tokenizer(src: string) {
        // [name] 且后面不跟 ( 或 [，避免吞掉链接 [text](url) 和引用链接 [text][ref]
        // name 须以字母（\p{L} 覆盖中文等 Unicode 字母）开头，且至少 2 个字符，避免误匹配 [1]、[x] 这类文本
        const match = /^\[([\p{L}][\p{L}\p{N}_-]+)\](?![\(\[])/u.exec(src);
        if (!match) return undefined;
        return {
          type: "sticker",
          raw: match[0],
          text: match[1],
        };
      },
      renderer(token) {
        // name 已被正则限制为安全字符，无需转义
        return `<img class="sticker" src="/stickers/${token.text}.png" alt="${token.text}" />`;
      },
    },
  ],
});

// 定义极简的中间数据结构
type SimpleNode =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      href: string;
      text: string;
      raw: string;
    }
  | {
      type: "sticker";
      text: string;
      raw: string;
    };

/**
 * 解析 marked 生成的 token AST 树，提取文本和图片节点的扁平数组
 * @param tokens marked 解析后的 token 数组
 * @returns 解析后的简单节点数组
 */
function flattenTokens(tokens: Token[]): SimpleNode[] {
  return tokens.flatMap((token): SimpleNode[] => {
    // 图片节点单独提取
    if (token.type === "image") {
      return [{ type: "image", href: token.href, text: token.text, raw: token.raw }];
    }
    if (token.type === "sticker") {
      return [{ type: "sticker", text: token.text, raw: token.raw }];
    }
    if (token.type === "link") {
      return [{ type: "text", text: token.raw }];
    }
    // 含子 tokens 的容器节点（paragraph、heading、strong 等），递归展开
    if ("tokens" in token && token.tokens?.length) {
      return flattenTokens(token.tokens);
    }
    // list 的子节点在 items 字段
    if (token.type === "list") {
      return flattenTokens(token.items);
    }
    // 其余叶子节点统一保持文本形式
    return [{ type: "text", text: token.raw }];
  });
}

/**
 * 处理单个图片的解析与读取
 */
async function resolveImage(href: string, alt?: string): Promise<ImagePart | null> {
  if (/^https?:\/\//i.test(href)) {
    const url = await download(href, { limit: 3 * 1024 * 1024 })
      .then(blobToDataURL)
      .catch(() => null);
    if (url) {
      return { type: "image", raw: `![${alt ?? ""}](${href})`, data: { file: url, url } };
    }
    return null;
  } else {
    const virtualPath = sanitizeImagePath(href);
    const url = await fetch(pathToFileURL(virtualToRealPath(virtualPath)))
      .then((r) => r.blob())
      .then(blobToDataURL)
      .catch(() => null);
    if (url) {
      return { type: "image", raw: `![${alt ?? ""}](${virtualPath})`, data: { file: url, url } };
    }
    return null;
  }
}

/**
 * 将简单数组转化为平台需要的消息数组
 */
function convertToParsedMessageParts(nodes: SimpleNode[]): ParsedMessagePart[] {
  // 将连续文本合并、图片/贴纸独立，生成交替的 文本 | 图片 | 贴纸 序列
  const segments: SimpleNode[] = [];
  for (const node of nodes) {
    if (node.type === "image" || node.type === "sticker") {
      segments.push(node);
      continue;
    }
    // 连续文本追加到末尾文本段，否则新建一段
    const last = segments.at(-1);
    if (last?.type === "text") last.text += node.text;
    else segments.push(node);
  }
  return segments.flatMap((segment): ParsedMessagePart[] => {
    if (segment.type === "text") return segment.text.trim() ? [segment.text.trim()] : [];
    if (segment.type === "sticker") {
      return [{ type: "sticker-reference", text: segment.text, raw: segment.raw }];
    }
    return [{ type: "image-reference", href: segment.href, text: segment.text, raw: segment.raw }];
  });
}

/**
 * 同步解析 Markdown 内容，不读取图片或贴纸文件
 * @param content Markdown 内容
 * @returns 文本和待解析媒体引用组成的消息数组
 */
export function parseMarkdown(content: string): ParsedMessagePart[] {
  return convertToParsedMessageParts(flattenTokens(marked.lexer(content)));
}

/**
 * 并发读取解析结果中的图片和贴纸，转换为平台消息
 */
export async function resolveMessageParts(parts: ParsedMessagePart[]): Promise<MessagePart[]> {
  return await Promise.all(
    parts.map(async (part): Promise<MessagePart> => {
      if (typeof part === "string") return part;
      if (part.type === "sticker-reference") return (await resolveSticker(part.text)) || part.raw;
      return (await resolveImage(part.href, part.text)) || part.raw;
    }),
  );
}
