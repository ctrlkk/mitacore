import type { PendingMessage, UnifiedInboundMessage } from ".";
import { generateText, type ModelMessage, type UserContent } from "ai";
import { dataPath, projectPath } from "./utils/path";
import { readFile } from "node:fs/promises";
import { getModel } from "./model";
import { downloadToCache } from "@/utils/image-cache";
import { compressImage } from "@/utils/image-resize";
import { imageToText } from "@/multimedia";
import { cache } from "@/utils/cache";
import { logger } from "@/logger";
import dayjs from "dayjs";
import XMLBuilder from "fast-xml-builder";

const formatSegments = (
  segments: UnifiedInboundMessage[],
  imageMap: Map<string, { path: string; description: string }>,
): string => {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      parts.push(seg.text);
    } else if (seg.type === "at") {
      if (seg.data.nickname) parts.push(`@${seg.data.nickname}`);
    } else if (seg.type === "image") {
      const img = imageMap.get(seg.data.url);
      if (img && img.path) {
        parts.push(`\`${img.path}\``);
      } else {
        parts.push("[图片]");
      }
    } else if (seg.type === "reply") {
      const inner = formatSegments(seg.data.segments, imageMap);
      parts.push(`<reply nickname="${seg.data.nickname}">${inner}</reply>`);
    }
  }
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(" ");
};

async function loadMainHistory(): Promise<ModelMessage[]> {
  try {
    const history = await readFile(dataPath("chat.json"), "utf8");
    return JSON.parse(history);
  } catch {
    return [];
  }
}

function parseTriggerDecisionXml(xml: string): { should_reply: boolean; reason: string } | null {
  const shouldReplyMatch = xml.match(/<should_reply>\s*(true|false)\s*<\/should_reply>/i);
  if (!shouldReplyMatch || shouldReplyMatch[1] === undefined) return null;
  const reasonMatch = xml.match(/<reason>([\s\S]*?)<\/reason>/i);
  const reason = reasonMatch?.[1]?.trim() ?? "";
  return {
    should_reply: shouldReplyMatch[1].toLowerCase() === "true",
    reason,
  };
}

function parseTriggerDecisionText(text: string) {
  const xmlStart = text.indexOf("<trigger_decision");
  const xmlEnd = text.lastIndexOf("</trigger_decision>");
  if (xmlStart < 0 || xmlEnd <= xmlStart) {
    logger.warn(
      { error: "未找到 <trigger_decision> 根标签", outputPreview: text.slice(0, 500) },
      "触发判定输出解析失败",
    );
    return null;
  }
  const block = text.slice(xmlStart, xmlEnd + "</trigger_decision>".length);
  const decision = parseTriggerDecisionXml(block);
  if (!decision) {
    logger.warn(
      { error: "候选 XML 缺少 <should_reply> 字段", outputPreview: text.slice(0, 500) },
      "触发判定输出解析失败",
    );
    return null;
  }
  return decision;
}

export async function dispatchMessage(pendingMessages: PendingMessage[]) {
  const rolePrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: triggerPrompt } = await import("./prompts/trigger.txt");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");

  const urls = new Set<string>();
  const extractImage = (segments: UnifiedInboundMessage[]) => {
    for (const seg of segments) {
      if (seg.type === "image") urls.add(seg.data.url);
      else if (seg.type === "reply") extractImage(seg.data.segments);
    }
  };
  for (const msg of pendingMessages) {
    extractImage(msg.unifiedMessages);
  }

  const imageMap = new Map<string, { path: string; description: string }>();
  if (urls.size > 0) {
    const downloaded = await Promise.all(
      Array.from(urls).map(async (url) => {
        try {
          const { virtualPath, realPath } = await downloadToCache(url);
          return { url, virtualPath, realPath };
        } catch (error) {
          logger.error({ url, error }, "下载失败");
          return null;
        }
      }),
    );

    const pathMap = new Map<string, { realPath: string; sourceUrls: string[] }>();
    for (const item of downloaded) {
      if (!item) continue;
      const group = pathMap.get(item.virtualPath);
      if (group) {
        group.sourceUrls.push(item.url);
      } else {
        pathMap.set(item.virtualPath, { realPath: item.realPath, sourceUrls: [item.url] });
      }
    }

    await Promise.all(
      Array.from(pathMap.entries()).map(async ([path, { realPath, sourceUrls }]) => {
        let description = await cache.get<string>(path);
        if (!description) {
          try {
            const blob = await compressImage(Bun.file(realPath));
            description = (await imageToText(blob)).trim();
            cache.set(path, description).catch((err) => {
              logger.error({ error: err }, "缓存图片描述失败");
            });
          } catch (error) {
            logger.error({ path, error }, "转述失败");
            description = "图片转述失败";
          }
        }

        for (const url of sourceUrls) {
          imageMap.set(url, { path, description });
        }
      }),
    );
  }

  const system = [
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    "<role>",
    "你是「对话触发判定 agent」，你的唯一职责是判断是否应当触发角色回复。",
    "你的判定必须基于客观信号，禁止凭空猜测用户的意图，禁止为了显得热情而触发回复。",
    "</role>",
    "",
    "当前角色设定为：",
    "<character>",
    rolePrompt.trim(),
    "</character>",
  ].join("\n");

  const conversation = pendingMessages
    .map((msg) => {
      const text = formatSegments(msg.unifiedMessages, imageMap);
      return `<message user_id="${msg.userId}" nickname="${msg.nickname}" date="${dayjs(msg.date).format("MM-DD HH:mm")}">\n${text}\n</message>`;
    })
    .join("\n\n");

  const history = await loadMainHistory();

  const filteredHistory: ModelMessage[] = [];
  const maxHistoryCount = 20;
  for (let i = history.length - 1; i >= 0; i--) {
    if (filteredHistory.length >= maxHistoryCount) break;
    const msg = history[i]!;
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") filteredHistory.push(msg);
    } else if (msg.role === "user") {
      filteredHistory.push(msg);
    }
  }
  filteredHistory.reverse();

  let finalPrompt = `${triggerPrompt.trim()}\n\n<conversation>\n${conversation.trim()}\n</conversation>`;

  // 去重并格式化图片描述，与 index.ts 中的 buildPrompt 逻辑保持一致
  const uniqueImages = Array.from(new Map(imageMap.values().map((img) => [img.path, img])).values());
  if (uniqueImages.length > 0) {
    const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
    const reminder = builder
      .build({
        system_reminder: {
          image: uniqueImages,
        },
      })
      .trim();
    finalPrompt = `${reminder}\n\n${finalPrompt}`;
  }

  const content: UserContent = [{ type: "text", text: finalPrompt }];

  const { text, reasoningText } = await generateText({
    model: getModel("deepseek-v4-flash"),
    system,
    messages: [...filteredHistory, { role: "user", content }],
  });
  logger.info({ reasoningText, text }, "触发判定输出");
  const decision = parseTriggerDecisionText(text);
  return decision?.should_reply ?? false;
}
