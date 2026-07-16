import { generateText, type LanguageModelUsage, type ModelMessage } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { parseMarkdown, type MessagePart } from "@/images";
import { splitMessage } from "@/message/splitter";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";

async function loadExecutorHistory(): Promise<ModelMessage[]> {
  try {
    const history = await readFile(dataPath("chat.json"), "utf8");
    return JSON.parse(history);
  } catch {
    return [];
  }
}

async function saveExecutorHistory(history: ModelMessage[], log: PinoLogger = logger) {
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
  const historyMessages: ModelMessage[] = await loadExecutorHistory();
  const runtimeMessages: ModelMessage[] = [];
  const model = getModel(config.models.reply);

  let usage: LanguageModelUsage | undefined;
  let replyText = "";

  const prompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");
  const { default: replyGroupPrompt } = await import("./prompts/reply-group.txt");
  // const { default: replyPrompt } = await import("./prompts/reply.txt");

  const system = [
    "<role>",
    prompt.trim(),
    "</role>",
    "",
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
  ].join("\n");

  const planContent = reasoning
    ? `${replyGroupPrompt.trim()}\n\n<reply_plan>\n${plan}\n</reply_plan>\n\n<reply_reasoning>\n${reasoning}\n</reply_reasoning>`
    : `${replyGroupPrompt.trim()}\n\n<reply_plan>\n${plan}\n</reply_plan>`;

  historyMessages.push(
    { role: "user", content: userPrompt },
    { role: "user", content: planContent },
  );

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      system,
      messages: [...historyMessages, ...runtimeMessages],
    });

    if (result.reasoning) log.info({ reasoning: result.reasoningText, step }, "内部思考");
    if (result.text) log.info({ text: result.text, step }, "助手响应");
    if (result.text) {
      const segments = await sliceReply(result.text);
      await onReply(segments);
      const sentText = segments
        .map((seg) => {
          if (typeof seg === "string") return seg;
          return seg.raw;
        })
        .join("\n");
      // 修剪assistant消息
      const firstMsg = result.response.messages[0];
      if (firstMsg && firstMsg.role === "assistant") firstMsg.content = sentText;
      // 收集reply文本
      replyText += sentText;
    }
    usage = result.usage;
    runtimeMessages.push(...result.response.messages);

    if (result.toolCalls.length === 0) break;
  }

  // 保存：historyMessages 去掉结尾的 plan + runtimeMessages
  await saveExecutorHistory([...historyMessages.slice(0, -1), ...runtimeMessages], log);
  return { replyText, usage };
}
