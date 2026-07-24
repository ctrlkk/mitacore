import { generateText, type LanguageModelUsage, type ToolSet } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { parseMarkdown, type MessagePart } from "@/images";
import { splitMessage } from "@/message/splitter";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";
import { type ChatHistory, migrateHistory, toModelMessages } from "@/types/chat-history";
import { imageGen } from "./tools/image-gen";
import { websearch } from "./tools/web-search";
import { compactHistory, isOverflow } from "./compaction";

async function loadHistory(): Promise<ChatHistory> {
  try {
    const raw = JSON.parse(await readFile(dataPath("history.json"), "utf8"));
    return migrateHistory(raw);
  } catch {
    return [];
  }
}

async function saveHistory(history: ChatHistory, log: PinoLogger = logger) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("history.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    log.error({ error }, "保存单 agent 历史失败");
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
 * 运行单 agent（兼具规划与回复，输出直接面向用户）
 * @param userPrompt 已用 <user_input> 标签包好的用户消息
 * @param onReply 实际发送消息的回调
 * @returns replyText（拼接所有 step 的文本）+ usage
 */
export async function runMain(
  userPrompt: string,
  onReply: (segments: MessagePart[]) => Promise<void>,
  log: PinoLogger = logger,
) {
  const mainAlias = config.models.main;
  if (!mainAlias) {
    throw new Error("未配置 models.main，无法使用单 agent 模式");
  }
  const model = getModel(mainAlias);

  const historyMessages: ChatHistory = await loadHistory();
  const runtimeMessages: ChatHistory = [];
  runtimeMessages.push({
    message: {
      role: "user",
      content: userPrompt,
    },
    timestamp: Date.now(),
  });

  let usage: LanguageModelUsage | undefined;

  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");

  const system = [
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    "<role>",
    replyPrompt.trim(),
    "</role>",
  ].join("\n");

  const tools: ToolSet = {};
  tools.image_gen = imageGen(tools, system, model);
  tools.web_search = websearch();

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      system,
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
      tools,
      maxOutputTokens: 4096,
    });

    if (result.reasoning) log.debug({ reasoning: result.reasoningText, step }, "内部思考");
    if (result.text) log.debug({ text: result.text, step }, "助手响应");
    if (result.text) {
      const segments = await sliceReply(result.text);
      await onReply(segments);
    }
    usage = result.usage;

    for (const step of result.steps) {
      for (const message of step.response.messages) {
        runtimeMessages.push({
          message,
          timestamp: Date.now(),
          usage: step.usage,
        });
      }
    }

    if (result.toolCalls.length === 0) break;
  }

  let finalHistory: ChatHistory = [...historyMessages, ...runtimeMessages];

  if (isOverflow(usage)) {
    log.info("检测到上下文溢出，开始执行压缩...");
    finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
  }

  await saveHistory(finalHistory, log);

  return { usage };
}
