import { tool } from "ai";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ACCEPT = {
  markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
  text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
  html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
};

export function webfetch() {
  return tool({
    description: [
      "从 HTTP 或 HTTPS URL 获取内容，并以文本、Markdown 或 HTML 返回，默认 Markdown。",
      "",
      "用法：",
      "- 用于获取和分析指定网页内容；如有更专用的工具，优先使用专用工具",
      "- URL 必须是完整且有效的 HTTP 或 HTTPS 地址",
      "- 此工具只读，不会修改任何文件",
      "- 大型响应会被限制为 5 MiB",
    ].join("\n"),
    inputSchema: z.object({
      url: z.string().url().describe("要获取内容的 HTTP 或 HTTPS URL"),
      format: z.enum(["text", "markdown", "html"]).optional().describe("返回格式，默认 markdown"),
      timeout: z.number().positive().max(120).optional().describe("超时秒数，最大 120 秒"),
    }),
    execute: async ({ url: input, format = "markdown", timeout }, { abortSignal }) => {
      const url = new URL(input);
      if (!/^https?:$/.test(url.protocol)) return "网页获取失败：URL 必须使用 http:// 或 https:// 协议";

      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, (timeout ?? 30) * 1000);
      abortSignal?.addEventListener("abort", abort, { once: true });

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: ACCEPT[format],
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);

        const contentType = response.headers.get("content-type") ?? "";
        const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          mime &&
          !mime.startsWith("text/") &&
          mime !== "application/json" &&
          !mime.endsWith("+json") &&
          mime !== "application/xml" &&
          !mime.endsWith("+xml") &&
          mime !== "application/javascript" &&
          mime !== "application/x-javascript"
        ) {
          throw new Error(`不支持获取 ${contentType} 类型的文件`);
        }

        const content = new TextDecoder().decode(await readBody(response));
        if (format === "html" || !contentType.includes("text/html")) return content;
        return formatHtml(content, format);
      } catch (error) {
        if (controller.signal.aborted) return "网页获取失败：请求超时或已取消";
        return `网页获取失败：${error instanceof Error ? error.message : "未知错误"}`;
      } finally {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", abort);
      }
    },
  });
}

async function readBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`响应过大，超过 ${MAX_RESPONSE_BYTES} 字节限制`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error(`响应过大，超过 ${MAX_RESPONSE_BYTES} 字节限制`);
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function formatHtml(html: string, format: "text" | "markdown"): string {
  if (format === "markdown") {
    const turndown = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    turndown.remove(["script", "style", "meta", "link"]);
    return turndown.turndown(html);
  }

  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++;
    },
    ontext(input) {
      if (skipDepth === 0) text += input;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}
