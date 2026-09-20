import { type ChatHistory, migrateHistory, toModelMessages } from "./chat-history";
import { generateText, type LanguageModelUsage } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModelForRole } from "@/agents/model";
import { parseMarkdown, resolveMessageParts, type ParsedMessagePart, type ReplyOutput } from "@/message/parts";
import { cleanMessage, splitMessage } from "@/message/splitter";
import { dataPath, projectPath } from "@/utils/path";
import { logger, type PinoLogger } from "@/logger";
import { compactHistory } from "./compaction";
import { config } from "@/config";
import { injectSystemContext } from "./system-context";
import { logUsage } from "@/utils/format";

async function loadHistory(): Promise<ChatHistory> {
  try {
    const raw = JSON.parse(await readFile(dataPath("chat.json"), "utf8"));
    return migrateHistory(raw);
  } catch {
    return [];
  }
}

async function saveHistory(history: ChatHistory, log: PinoLogger = logger) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("chat.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    log.error({ err: error }, "保存执行层历史失败");
  }
}

function cleanReply(chunk: string): ParsedMessagePart[] {
  return parseMarkdown(chunk).map((part) => (typeof part === "string" ? cleanMessage(part) : part));
}

function sliceReply(parts: ParsedMessagePart[]): ParsedMessagePart[] {
  const result: ParsedMessagePart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const seg of splitMessage(part, { maxSplitNum: 10 })) {
        if (seg.trim()) result.push(seg);
      }
    } else {
      result.push(part);
    }
  }
  return result;
}

function joinReply(parts: ParsedMessagePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.raw)).join("\n");
}

function joinSpeechText(parts: ParsedMessagePart[]): string {
  return parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
}

/**
 * 创建本轮回复层会话
 * @param userPrompt 已用 <user_input> 标签包好的用户消息
 * @param onReply 实际发送消息的回调
 */
export async function createReplySession(
  userPrompt: string,
  onReply: (output: ReplyOutput) => Promise<void>,
  log: PinoLogger = logger,
): Promise<{
  send: (plan: string, reasoning: string) => Promise<{ replyText: string; usage: LanguageModelUsage | undefined }>;
}> {
  const model = getModelForRole("reply");

  let historyMessages: ChatHistory = await loadHistory();
  const { records } = await injectSystemContext(historyMessages, userPrompt, log);
  historyMessages = [...historyMessages, ...records];

  const prompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: capabilitiesPrompt } = await import("../prompts/capabilities.txt?raw");
  const { default: replyGroupPrompt } = await import("../prompts/reply-group.txt?raw");

  const system = [
    "<role>",
    prompt.trim(),
    "</role>",
    "",
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
  ].join("\n");

  return {
    async send(plan: string, reasoning: string) {
      const planContent = [
        replyGroupPrompt,
        "",
        "<reply_reasoning>",
        reasoning,
        "</reply_reasoning>",
        "",
        "<reply_plan>",
        plan,
        "</reply_plan>",
      ].join("\n");

      const result = await generateText({
        model,
        instructions: system,
        messages: [...toModelMessages(historyMessages), { role: "user", content: planContent }],
      });

      log.info({ reasoningText: result.finalStep.reasoningText, text: result.text }, "助手响应");
      logUsage(log, result.usage);

      const cleanedReply = cleanReply(result.text);
      const replyContent = joinReply(cleanedReply);
      const segments = await resolveMessageParts(sliceReply(cleanedReply));
      if (segments.length > 0) await onReply({ segments, speechText: joinSpeechText(cleanedReply) });

      let finalHistory: ChatHistory = [...historyMessages];
      if (replyContent) {
        finalHistory.push({
          message: { role: "assistant", content: replyContent },
          timestamp: Date.now(),
          usage: result.usage,
        });
      }

      if ((result.usage.totalTokens ?? 0) >= config.context.reply.max_tokens) {
        log.info("检测到上下文溢出，开始执行压缩...");
        finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
      }
      await saveHistory(finalHistory, log);
      historyMessages = finalHistory;

      return { replyText: replyContent, usage: result.usage };
    },
  };
}
