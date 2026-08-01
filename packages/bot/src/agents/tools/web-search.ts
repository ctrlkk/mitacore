import { tool } from "ai";
import { z } from "zod";

const TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface SearchResultItem {
  url: string;
  title: string;
  publish_date: string | null;
  excerpts: string[];
}

interface SearchResponse {
  search_id: string;
  results: SearchResultItem[];
  warnings: string[] | null;
  usage: { name: string; count: number }[];
  session_id: string;
}

interface WebSearchInput {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
}

type Provider = "exa" | "parallel";

interface McpContentItem {
  type: string;
  text: string;
}

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: { content: McpContentItem[] };
  error?: { code: number; message: string };
}

function selectProvider(toolCallId: string): Provider {
  let hash = 0x811c9dc5;
  for (const char of toolCallId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2 === 0 ? "exa" : "parallel";
}

function parsePayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const data = JSON.parse(trimmed) as McpResponse;
    return data.result?.content?.find((item) => item.text)?.text;
  } catch {
    return undefined;
  }
}

function parseResponse(body: string): string | undefined {
  const trimmed = body.trim();

  const direct = parsePayload(trimmed);
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = parsePayload(line.substring(6));
    if (data) return data;
  }

  return undefined;
}

function tryParseJson(text: string): SearchResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function formatResults(data: SearchResultItem[]): string {
  const parts: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i]!;
    const lines: string[] = [];

    lines.push(`### ${i + 1}. ${item.title}`);
    lines.push(`URL: ${item.url}`);
    if (item.publish_date) lines.push(`Date: ${item.publish_date}`);
    lines.push("");

    for (const excerpt of item.excerpts) {
      // 截断过长的 excerpt，避免单条结果占满上下文
      const trimmed = excerpt.length > 2000 ? excerpt.slice(0, 2000) + "..." : excerpt;
      lines.push(trimmed);
    }

    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n---\n\n");
}

async function callMcp(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<string | undefined> {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`${toolName} returned HTTP ${response.status}`);

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new Error(`${toolName} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }

    const body = await response.text();

    if (new TextEncoder().encode(body).length > MAX_RESPONSE_BYTES) {
      throw new Error(`${toolName} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }

    return parseResponse(body);
  } finally {
    clearTimeout(timer);
  }
}

function callExa(input: WebSearchInput, apiKey?: string): Promise<string | undefined> {
  const url = new URL("https://mcp.exa.ai/mcp");
  if (apiKey) url.searchParams.set("exaApiKey", apiKey);

  return callMcp(url.toString(), "web_search_exa", {
    query: input.query,
    type: input.type ?? "auto",
    numResults: input.numResults ?? 8,
    livecrawl: input.livecrawl ?? "fallback",
    ...(input.contextMaxCharacters != null ? { contextMaxCharacters: input.contextMaxCharacters } : {}),
  });
}

function callParallel(query: string, sessionID: string, apiKey?: string): Promise<string | undefined> {
  const headers: Record<string, string> = {
    "User-Agent": "web-search/1.0",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return callMcp(
    "https://search.parallel.ai/mcp",
    "web_search",
    {
      objective: query,
      search_queries: [query],
      session_id: sessionID,
    },
    headers,
  );
}

export function websearch() {
  return tool({
    description:
      "搜索网络获取截止日期之后的实时信息。执行实时网络搜索并返回最相关网站的内容。\n\n" +
      "用法：\n" +
      "- 用于获取最新信息、当前事件和近期数据\n" +
      "- 支持实时爬取模式：'fallback'（缓存不可用时回退到实时爬取）或 'preferred'（优先实时爬取）\n" +
      "- 搜索类型：'auto'（均衡）、'fast'（快速）、'deep'（深度搜索）\n" +
      `- 当前年份是 ${new Date().getFullYear()}，搜索近期信息或当前事件时必须使用今年`,
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
    execute: async ({ query, numResults, livecrawl, type, contextMaxCharacters }, options) => {
      const toolCallId = options?.toolCallId ?? crypto.randomUUID();
      const provider = selectProvider(toolCallId);

      try {
        const raw =
          provider === "exa"
            ? await callExa({ query, numResults, livecrawl, type, contextMaxCharacters })
            : await callParallel(query, toolCallId);

        const rawText = raw ?? "No search results found. Please try a different query.";
        const data = tryParseJson(rawText);

        return data?.results ? formatResults(data.results) : rawText;
      } catch (error) {
        return `Search failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    },
  });
}
