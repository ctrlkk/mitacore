import { tool } from "ai";
import { z } from "zod";

const TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface SearchInput {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
}

interface SearchResult {
  url: string;
  title: string;
  publish_date: string | null;
  excerpts: string[];
}

export function websearch() {
  return tool({
    description: [
      "搜索网络获取截止日期之后的实时信息。执行实时网络搜索并返回最相关网站的内容。",
      "",
      "用法：",
      "- 用于获取最新信息、当前事件和近期数据",
      "- 支持实时爬取模式：'fallback'（缓存不可用时回退到实时爬取）或 'preferred'（优先实时爬取）",
      "- 搜索类型：'auto'（均衡）、'fast'（快速）、'deep'（深度搜索）",
      `- 当前年份是 ${new Date().getFullYear()}，搜索近期信息或当前事件时必须使用今年`,
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().describe("网络搜索查询词"),
      numResults: z.number().int().min(1).max(20).optional().describe("搜索结果数量（默认 8，最大 20）"),
      livecrawl: z.enum(["fallback", "preferred"]).optional().describe("实时爬取模式（默认 'fallback'）"),
      type: z.enum(["auto", "fast", "deep"]).optional().describe("搜索类型（默认 'auto'）"),
      contextMaxCharacters: z
        .number()
        .int()
        .min(1)
        .max(50000)
        .optional()
        .describe("上下文最大字符数（默认 10000，最大 50000）"),
    }),
    execute: async (input, options) => {
      const sessionId = options?.toolCallId ?? crypto.randomUUID();

      try {
        const output =
          selectProvider(sessionId) === "exa" ? await searchExa(input) : await searchParallel(input.query, sessionId);
        return formatSearchOutput(output ?? "No search results found. Please try a different query.");
      } catch (error) {
        return `Search failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    },
  });
}

function selectProvider(id: string) {
  let hash = 0x811c9dc5;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2 === 0 ? "exa" : "parallel";
}

function formatSearchOutput(output: string): string {
  try {
    const data = JSON.parse(output) as { results?: SearchResult[] };
    if (data.results) return formatResults(data.results);
  } catch {
    // Parallel 返回的内容不是统一的 JSON 搜索结果格式。
  }
  return output;
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((result, index) => {
      const excerpts = result.excerpts.map((excerpt) => (excerpt.length > 2000 ? `${excerpt.slice(0, 2000)}...` : excerpt));
      return [
        `### ${index + 1}. ${result.title}`,
        `URL: ${result.url}`,
        ...(result.publish_date ? [`Date: ${result.publish_date}`] : []),
        "",
        ...excerpts,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function searchExa(input: SearchInput): Promise<string | undefined> {
  return callMcp("https://mcp.exa.ai/mcp", "web_search_exa", {
    query: input.query,
    type: input.type ?? "auto",
    numResults: input.numResults ?? 8,
    livecrawl: input.livecrawl ?? "fallback",
    ...(input.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: input.contextMaxCharacters }),
  });
}

function searchParallel(query: string, sessionId: string): Promise<string | undefined> {
  return callMcp(
    "https://search.parallel.ai/mcp",
    "web_search",
    { objective: query, search_queries: [query], session_id: sessionId },
    { "User-Agent": "web-search/1.0" },
  );
}

async function callMcp(
  url: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    return readMcpContent(await readBody(response, name));
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(response: Response, name: string): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`${name} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error(`${name} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
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
  return new TextDecoder().decode(body);
}

function readMcpContent(body: string): string | undefined {
  const payloads = [body.trim(), ...body.split("\n").flatMap((line) => (line.startsWith("data: ") ? [line.slice(6)] : []))];
  for (const payload of payloads) {
    try {
      const data = JSON.parse(payload) as { result?: { content?: { text?: string }[] } };
      const text = data.result?.content?.find((item) => item.text)?.text;
      if (text) return text;
    } catch {
      // SSE 的非 data 行和非 JSON 响应不包含工具结果。
    }
  }
}
