import type { PendingMessage, UnifiedInboundMessage } from ".";
import { generateText, type ModelMessage, type UserContent } from "ai";
import { dataPath, projectPath } from "./utils/path";
import { readFile } from "node:fs/promises";
import { getModel } from "./model";
import { downloadToCache } from "@/utils/image-cache";
import { blobToDataURL } from "./utils/blob";
import { logger } from "@/logger";
import dayjs from "dayjs";

const formatSegments = (
  segments: UnifiedInboundMessage[],
  imageMap: Map<string, { path: string; blob: Blob }>,
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

export async function dispatchMessage(cache: PendingMessage[]) {
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
  for (const msg of cache) {
    extractImage(msg.unifiedMessages);
  }

  const imageMap = new Map<string, { path: string; blob: Blob }>();
  if (urls.size > 0) {
    await Promise.all(
      Array.from(urls).map(async (url) => {
        try {
          const { virtualPath, realPath } = await downloadToCache(url);
          const compressed = await new Bun.Image(Bun.file(realPath)).webp({ quality: 80 }).blob();
          imageMap.set(url, { path: virtualPath, blob: compressed });
        } catch {
          // skip
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

  const conversation = cache
    .map((msg) => {
      const text = formatSegments(msg.unifiedMessages, imageMap);
      return `<message user_id="${msg.userId}" nickname="${msg.nickname}" date="${dayjs(msg.date).format("MM-DD HH:mm")}">\n${text}\n</message>`;
    })
    .join("\n\n");

  const history = await loadMainHistory();

  const historyText: string[] = [];
  history.slice(-20).forEach((msg) => {
    if (msg.content instanceof Array) return;
    historyText.push(`<message role="${msg.role === "assistant" ? "你" : msg.role}">\n${msg.content}\n</message>`);
  });

  const prompt =
    `${triggerPrompt.trim()}\n\n` +
    `<history>\n` +
    `  ${historyText.join("\n\n").trim()}\n` +
    `</history>\n` +
    `<conversation>\n` +
    `  ${conversation.trim()}\n` +
    `</conversation>`;

  const labeledImages = await Promise.all(
    Array.from(imageMap.entries()).map(async ([url, { path, blob }]) => ({
      path,
      data: await blobToDataURL(blob),
    })),
  );

  const content: UserContent = [];
  for (const { path, data } of labeledImages) {
    content.push({ type: "text", text: `图片: ${path}` });
    content.push({ type: "image", image: data });
  }
  content.push({ type: "text", text: prompt });

  const { text } = await generateText({
    model: getModel("mimo-v2.5"),
    system,
    messages: [{ role: "user", content }],
  });
  logger.info({ text }, "触发判定输出");
  const decision = parseTriggerDecisionText(text);
  return decision?.should_reply ?? false;
}
