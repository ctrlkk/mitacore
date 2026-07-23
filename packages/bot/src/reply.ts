import { type ChatHistory, migrateHistory, toModelMessages } from "@/types/chat-history";
import { generateText, type LanguageModelUsage } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { parseMarkdown, type MessagePart } from "@/images";
import { splitMessage } from "@/message/splitter";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";
import { compactHistory, isOverflow } from "./compaction";
import { getStickersPrompt } from "./stickers";

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
    log.error({ error }, "保存执行层历史失败");
  }
}

async function sliceReply(chunk: string): Promise<MessagePart[]> {
  const parts = await parseMarkdown(chunk);
  const result: MessagePart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const seg of splitMessage(part, { maxSplitNum: 5 })) {
        if (seg.trim()) result.push(seg);
      }
    } else {
      result.push(part);
    }
  }
  return result;
}

/**
 * 运行回复层（仙狐小姐 persona）
 * @param userPrompt 已用 <user_input> 标签包好的用户消息
 * @param plan 规划层生成的策略
 * @param reasoning 规划层的思考过程
 * @param onReply 实际发送消息的回调
 * @returns replyText（拼接所有 step 的文本）+ usage
 */
export async function runReply(
  userPrompt: string,
  plan: string,
  reasoning: string,
  onReply: (segments: MessagePart[]) => Promise<void>,
  log: PinoLogger = logger,
): Promise<{ replyText: string; usage: LanguageModelUsage | undefined }> {
  const historyMessages: ChatHistory = await loadHistory();
  const runtimeMessages: ChatHistory = [];
  const model = getModel(config.models.reply);

  let usage: LanguageModelUsage | undefined;
  let replyText = "";

  const prompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");
  const { default: replyGroupPrompt } = await import("./prompts/reply-group.txt");
  const stickersPrompt = await getStickersPrompt();

  const system = [
    "<role>",
    prompt.trim(),
    "</role>",
    "",
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    stickersPrompt.trim(),
  ].join("\n");

  const planContent = reasoning
    ? `${replyGroupPrompt.trim()}\n\n<reply_plan>\n${plan}\n</reply_plan>\n\n<reply_reasoning>\n${reasoning}\n</reply_reasoning>`
    : `${replyGroupPrompt.trim()}\n\n<reply_plan>\n${plan}\n</reply_plan>`;

  // 追加 user 消息和 plan 消息作为 record
  historyMessages.push(
    { message: { role: "user", content: userPrompt }, timestamp: Date.now() },
    { message: { role: "user", content: planContent }, timestamp: Date.now() },
  );

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      system,
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
    });

    if (result.reasoning) log.info({ reasoning: result.reasoningText, step }, "内部思考");
    if (result.text) log.info({ text: result.text, step }, "助手响应");

    const stepMsgs = result.response.messages;

    if (result.text) {
      const segments = await sliceReply(result.text);
      await onReply(segments);
      const sentText = segments
        .map((seg) => {
          if (typeof seg === "string") return seg;
          return seg.raw;
        })
        .join("\n");

      // 修剪assistant消息（仅对首条 assistant 有效）
      stepMsgs.forEach((msg, i) => {
        if (i === 0 && msg.role === "assistant") {
          msg.content = sentText;
        }
      });

      replyText += sentText;
    }

    // 把该 step 产出的消息追加为 ChatRecord，首条带 usage
    stepMsgs.forEach((msg, i) => {
      runtimeMessages.push({
        message: msg,
        timestamp: Date.now(),
        usage: i === 0 ? result.usage : undefined,
      });
    });

    usage = result.usage;

    if (result.toolCalls.length === 0) break;
  }

  let finalHistory: ChatHistory = [...historyMessages.slice(0, -1), ...runtimeMessages];
  if (isOverflow(usage)) {
    log.info("检测到上下文溢出，开始执行压缩...");
    finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
  }
  await saveHistory(finalHistory, log);

  return { replyText, usage };
}
