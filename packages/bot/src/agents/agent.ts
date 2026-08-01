import { generateText, type LanguageModelUsage, type ToolSet } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModel } from "@/ai/model";
import { parseMarkdown, resolveMessageParts, type MessagePart, type ParsedMessagePart } from "@/message/parts";
import { splitMessage } from "@/message/splitter";
import { dataPath, projectPath } from "@/utils/path";
import { logUsage } from "@/utils/format";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";
import { type ChatHistory, migrateHistory, toModelMessages } from "./chat-history";
import { imageGen } from "./tools/image-gen";
import { task } from "./tools/task";
import { websearch } from "./tools/web-search";
import { compactHistory, isOverflow } from "./compaction";
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
    log.error({ error }, "保存单 agent 历史失败");
  }
}

function sliceReply(chunk: string): ParsedMessagePart[] {
  const parts = parseMarkdown(chunk);
  const result: ParsedMessagePart[] = [];
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

function joinReply(parts: ParsedMessagePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.raw)).join("\n");
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

  const { records } = await injectSystemContext(historyMessages, userPrompt, log);
  const runtimeMessages: ChatHistory = [...records];
  const savedMessages: ChatHistory = [...records];

  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const { default: capabilitiesPrompt } = await import("../prompts/capabilities.txt");
  const { default: workspacePrompt } = await import("../workspace/memory.txt");

  const system = [
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    "<role>",
    replyPrompt.trim(),
    "</role>",
    "",
    "<workspace_instructions>",
    workspacePrompt.trim(),
    "</workspace_instructions>",
  ].join("\n");

  const tools: ToolSet = { ...workspaceTools };
  tools.task = task(log);
  tools.image_gen = imageGen(tools, system, model);
  tools.web_search = websearch();

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      instructions: system,
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
      tools,
      maxOutputTokens: 4096,
      async onLanguageModelCallEnd({ content, usage }) {
        const reasoningText = content
          .filter((part) => part.type === "reasoning")
          .map((part) => part.text)
          .join("");
        const text = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        logUsage(log, usage);
        log.info({ reasoningText, text }, "助手响应");
        for (const part of content) {
          if (part.type !== "text") continue;
          const segments = await resolveMessageParts(sliceReply(part.text));
          if (segments.length > 0) await onReply(segments);
        }
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
            const content = joinReply(sliceReply(message.content));
            if (content) {
              savedMessages.push({ message: { ...message, content }, timestamp, usage: messageUsage });
            }
            continue;
          }

          const content = message.content.flatMap((part): typeof message.content => {
            if (part.type !== "text") return [part];
            const text = joinReply(sliceReply(part.text));
            return text ? [{ type: "text", text }] : [];
          });
          if (content.length > 0) {
            savedMessages.push({ message: { ...message, content }, timestamp, usage: messageUsage });
          }
        }
      },
    });

    if (result.toolCalls.length === 0) {
      let finalHistory: ChatHistory = [...historyMessages, ...savedMessages];

      if (isOverflow(result.finalStep.usage)) {
        log.info("检测到上下文溢出，开始执行压缩...");
        finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
      }

      await saveHistory(finalHistory, log);
    }
  }
}
