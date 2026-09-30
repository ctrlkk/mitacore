import { generateText, type LanguageModelUsage, type ToolSet } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModelForRole } from "@/agents/model";
import { parseMarkdown, resolveMessageParts, type ParsedMessagePart, type ReplyOutput } from "@/message/parts";
import { cleanMessage, splitMessage } from "@/message/splitter";
import { dataPath, projectPath } from "@/utils/path";
import { logUsage } from "@/utils/format";
import { logger, type PinoLogger } from "@/logger";
import { type ChatHistory, migrateHistory, toModelMessages } from "./chat-history";
import { imageGen } from "./tools/image-gen";
import { task } from "./tools/task";
import { webfetch } from "./tools/web-fetch";
import { websearch } from "./tools/web-search";
import { compactHistory } from "./compaction";
import { config } from "@/config";
import { injectSystemContext } from "./system-context";
import { workspaceTools } from "@/workspace/tool";

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
    log.error({ err: error }, "保存单 agent 历史失败");
  }
}

function cleanReply(chunk: string): ParsedMessagePart[] {
  return parseMarkdown(chunk).map((part) =>
    typeof part === "string" ? cleanMessage(part, config.splitter.remove_bracketed_narration) : part,
  );
}

function sliceReply(parts: ParsedMessagePart[]): ParsedMessagePart[] {
  const result: ParsedMessagePart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const seg of splitMessage(part, {
        enable: config.splitter.enable,
        maxLength: config.splitter.max_length,
        maxSentenceNum: config.splitter.max_sentence_num,
        maxSplitNum: config.splitter.max_split_num,
        enableOverflowReturnAll: config.splitter.enable_overflow_return_all,
      })) {
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
 * 运行单 agent（兼具规划与回复，输出直接面向用户）
 * @param userPrompt 已用 <user_input> 标签包好的用户消息
 * @param onReply 实际发送消息的回调
 * @param takeSteeringPrompt 在每个模型调用结束后提取工具循环期间新到达的用户消息
 * @returns replyText（拼接所有 step 的文本）+ usage
 */
export async function runMain(
  userPrompt: string,
  onReply: (output: ReplyOutput) => Promise<void>,
  log: PinoLogger = logger,
  takeSteeringPrompt?: () => Promise<string | undefined>,
) {
  const model = getModelForRole("main");

  const historyMessages: ChatHistory = await loadHistory();

  const { records } = await injectSystemContext(historyMessages, userPrompt, log);
  const runtimeMessages: ChatHistory = [...records];
  const savedMessages: ChatHistory = [...records];

  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: capabilitiesPrompt } = await import("../prompts/capabilities.txt?raw");
  const { default: workspacePrompt } = await import("../workspace/memory.txt?raw");

  const system = [
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    "<role>",
    replyPrompt.trim(),
    "</role>",
    // "",
    // "<workspace_instructions>",
    // workspacePrompt.trim(),
    // "</workspace_instructions>",
  ].join("\n");

  const tools: ToolSet = {};
  tools.task = task(log);
  tools.image_gen = imageGen(tools, system, model);
  tools.web_search = websearch();
  tools.web_fetch = webfetch();

  let stepsSinceUserPrompt = 0;
  while (stepsSinceUserPrompt < 20) {
    stepsSinceUserPrompt++;
    const result = await generateText({
      model,
      instructions: system,
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
      tools,
      async onLanguageModelCallEnd({ content, usage }) {
        const reasoningText = content
          .filter((part) => part.type === "reasoning")
          .map((part) => part.text)
          .join("");
        const text = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        log.info({ reasoningText, text }, "助手响应");
        logUsage(log, usage);
        const cleanedReply = content.flatMap((part): ParsedMessagePart[] =>
          part.type === "text" ? cleanReply(part.text) : [],
        );
        const segments = await resolveMessageParts(sliceReply(cleanedReply));
        if (segments.length > 0) await onReply({ segments, speechText: joinSpeechText(cleanedReply) });
      },
      onToolExecutionStart({ toolCall }) {
        log.info({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input }, "工具调用");
      },
      onToolExecutionEnd({ toolCall }) {
        log.info({ toolName: toolCall.toolName }, "工具执行结束");
      },
      onStepEnd(step) {
        for (const [index, message] of step.response.messages.entries()) {
          const timestamp = Date.now();
          const messageUsage = index === 0 ? step.usage : undefined;
          runtimeMessages.push({ message, timestamp, usage: messageUsage });

          if (message.role !== "assistant") {
            savedMessages.push({ message, timestamp, usage: messageUsage });
            continue;
          }

          if (typeof message.content === "string") {
            const content = joinReply(cleanReply(message.content));
            if (content) {
              savedMessages.push({ message: { ...message, content }, timestamp, usage: messageUsage });
            }
            continue;
          }

          const content = message.content.flatMap((part): typeof message.content => {
            if (part.type !== "text") return [part];
            const text = joinReply(cleanReply(part.text));
            return text ? [{ type: "text", text }] : [];
          });
          if (content.length > 0) {
            savedMessages.push({ message: { ...message, content }, timestamp, usage: messageUsage });
          }
        }
      },
    });

    // generateText 返回时，本轮模型输出和工具结果都已写入历史；此处是插入 user 消息的安全边界。
    const steeringPrompt = await takeSteeringPrompt?.();
    if (steeringPrompt !== undefined) {
      const { records: steeringRecords } = await injectSystemContext(
        [...historyMessages, ...savedMessages],
        steeringPrompt,
        log,
      );
      // runtimeMessages 供下一次模型调用使用，savedMessages 保证中途消息最终会持久化。
      runtimeMessages.push(...steeringRecords);
      savedMessages.push(...steeringRecords);
      // 新用户输入开启新的回合，不应继承上一条输入已经消耗的工具循环额度。
      stepsSinceUserPrompt = 0;
    }

    if (result.toolCalls.length === 0 && steeringPrompt === undefined) {
      let finalHistory: ChatHistory = [...historyMessages, ...savedMessages];

      if ((result.finalStep.usage.totalTokens ?? 0) >= config.context.main.max_tokens) {
        log.info("检测到上下文溢出，开始执行压缩...");
        finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
      }

      await saveHistory(finalHistory, log);
      return;
    }
  }
}
