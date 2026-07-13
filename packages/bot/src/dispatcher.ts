import type { PendingMessage, UnifiedInboundMessage } from ".";
import { generateText, type ModelMessage } from "ai";
import { dataPath, projectPath } from "./utils/path";
import { readFile } from "node:fs/promises";
import { getModel } from "./model";
import { z } from "zod";
import { logger } from "@/logger";
import dayjs from "dayjs";

const formatSegments = (segments: UnifiedInboundMessage[]): string => {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      parts.push(seg.text);
    } else if (seg.type === "at") {
      if (seg.data.nickname) parts.push(`@${seg.data.nickname}`);
    } else if (seg.type === "image") {
      parts.push("[图片]");
    } else if (seg.type === "reply") {
      const inner = formatSegments(seg.data.segments);
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

const zTriggerDecision = z.object({
  should_reply: z.boolean().describe("是否应当触发角色回复"),
  reason: z.string().describe("简短的判定理由"),
});

function parseTriggerDecisionText(text: string) {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(text.slice(jsonStart, jsonEnd + 1).trim());
  candidates.push(text.trim());

  let lastError = "未找到可解析的 JSON";
  for (const candidate of candidates.filter((candidate, index, list) => list.indexOf(candidate) === index)) {
    try {
      const result = zTriggerDecision.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
      lastError = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  logger.warn({ error: lastError, outputPreview: text.slice(0, 500) }, "触发判定输出解析失败");
  return null;
}

export async function dispatchMessage(cache: PendingMessage[]) {
  const rolePrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: triggerPrompt } = await import("./prompts/trigger.txt");

  const conversation = cache
    .map((msg) => {
      const text = formatSegments(msg.unifiedMessages);
      return `<message user_id="${msg.userId}" nickname="${msg.nickname}" date="${dayjs(msg.date).format("MM-DD HH:mm")}">\n${text}\n</message>`;
    })
    .join("\n\n");

  const history = await loadMainHistory();

  const historyText: string[] = [];
  for (const [index, msg] of history.entries()) {
    if (msg.content instanceof Array) continue;
    if (historyText.length > 20) break;
    historyText.push(`<message role="${msg.role}">\n${msg.content}\n</message>`);
  }

  const prompt =
    `${triggerPrompt.trim()}\n\n` +
    `<history>\n` +
    `  ${historyText.join("\n\n").trim()}\n` +
    `</history>\n` +
    `<conversation>\n` +
    `  ${conversation.trim()}\n` +
    `</conversation>`;

  const { text } = await generateText({
    model: getModel("deepseek-v4-flash"),
    system: rolePrompt.trim(),
    prompt,
  });
  logger.debug({ text }, "触发判定输出");
  const decision = parseTriggerDecisionText(text);
  if (!decision) return false;
  return decision.should_reply;
}
