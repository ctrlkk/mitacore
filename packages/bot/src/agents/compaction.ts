import { toModelMessages, type ChatHistory, type ChatRecord } from "./chat-history";
import { generateText, type LanguageModel, type LanguageModelUsage, type ToolSet } from "ai";
import { logger, type PinoLogger } from "@/logger";

/**
 * 获取某条记录的累计 token (即如果再发一轮对话，此时历史的总 input token)
 * 等于上一次的 inputTokens + outputTokens
 */
function getCumulativeTokens(record: ChatRecord): number | undefined {
  const usage = record.usage;
  if (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined) {
    return usage.inputTokens + usage.outputTokens;
  }
  return undefined;
}

/**
 * 退回方案：当历史中完全没有 usage 信息时，用字符长度粗略估算
 */
function splitHistoryByEstimate(history: ChatHistory, preserveBudget: number) {
  let tailTokens = 0;
  let splitIndex = history.length;

  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = Math.ceil(JSON.stringify(history[i]!.message).length / 4);
    if (tailTokens + tokens > preserveBudget) {
      break;
    }
    tailTokens += tokens;
    if (history[i]!.message.role === "user") {
      splitIndex = i;
    }
    if (i === history.length - 1 && splitIndex === history.length) {
      splitIndex = i;
    }
  }
  return { head: history.slice(0, splitIndex), tail: history.slice(splitIndex) };
}

/**
 * 将历史记录切分为需要被压缩的 [head] 和需要被保留的 [tail]
 * 优先利用 ChatRecord 中的真实 usage 信息进行精准切分
 */
export function splitHistory(history: ChatHistory, preserveBudget = 8000): { head: ChatHistory; tail: ChatHistory } {
  if (history.length === 0) {
    return { head: [], tail: [] };
  }

  // 1. 找到最后一次请求的真实上下文 token 数
  let lastContextTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.message.role === "assistant") {
      const tokens = getCumulativeTokens(history[i]!);
      if (tokens !== undefined) {
        lastContextTokens = tokens;
        break;
      }
    }
  }

  // 如果历史中完全没有 usage 信息（比如旧版本数据），退回到字符估算
  if (!lastContextTokens) {
    return splitHistoryByEstimate(history, preserveBudget);
  }

  // 2. 计算目标切分阈值：希望 head 的大小 <= targetTokens
  const targetTokens = lastContextTokens - preserveBudget;

  // 3. 正序遍历寻找切分点
  // 我们要找的是最后一个满足条件 (cumulativeTokens <= targetTokens) 的 assistant，
  // 然后把它后面的 user 消息作为 tail 的起点。
  let splitIndex = history.length;

  for (let i = 0; i < history.length; i++) {
    if (history[i]!.message.role === "user" && i > 0) {
      const prevAssistant = history[i - 1];
      if (prevAssistant?.message.role === "assistant") {
        const prevTokens = getCumulativeTokens(prevAssistant!);
        if (prevTokens !== undefined && prevTokens <= targetTokens) {
          splitIndex = i;
        }
      }
    }
  }

  // 边界情况：极其罕见，说明单轮对话就超了 8000 token
  if (splitIndex === history.length) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.message.role === "user") {
        splitIndex = i;
        break;
      }
    }
  }

  return {
    head: history.slice(0, splitIndex),
    tail: history.slice(splitIndex),
  };
}

/**
 * 执行上下文压缩
 * @param model 用于生成摘要的模型实例
 * @param system 调用方构建的系统提示词
 * @param messages 完整的历史记录 (ChatHistory，需包含 usage 以进行精准切分)
 * @param summaryPrompt 摘要提示词模板
 * @param tools 可能使用到的工具集
 */
export async function compactHistory(
  model: LanguageModel,
  system: string,
  messages: ChatHistory,
  tools?: ToolSet,
  log: PinoLogger = logger,
): Promise<ChatHistory> {
  const { head, tail } = splitHistory(messages);

  if (head.length === 0) {
    log.warn("无需压缩：头部为空或保留预算未超出");
    return messages;
  }
  const { default: summaryPrompt } = await import("../prompts/summary.txt?raw");
  const userContent = `<system_reminder>${summaryPrompt.trim()}</system_reminder>`;

  log.info({ headCount: head.length, tailCount: tail.length }, "开始执行上下文压缩");

  const { reasoningText, text: summary } = await generateText({
    model,
    system,
    messages: [...toModelMessages(head), { role: "user", content: userContent }],
    tools,
    maxOutputTokens: 4096,
  });

  log.info({ reasoningText, summary }, "压缩摘要生成完毕");
  const now = Date.now();
  // 丢弃 head，保留锚点 + 摘要 + tail
  return [
    {
      message: {
        role: "user",
        content: "<system_reminder>到目前为止我们都聊了些什么？</system_reminder>",
      },
      timestamp: now,
    },
    {
      message: { role: "assistant", content: summary },
      timestamp: now,
      summary: true,
    },
    ...tail,
  ];
}

/**
 * 判断是否溢出（需要压缩）
 */
export function isOverflow(usage?: LanguageModelUsage): boolean {
  if (!usage) return false;
  const totalTokens = usage.totalTokens || 0;
  return totalTokens >= 108000;
}
