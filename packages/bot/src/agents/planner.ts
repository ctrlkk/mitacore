import { type ChatHistory, migrateHistory, toModelMessages } from "./chat-history";
import { generateText, hasToolCall, isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getModel } from "@/ai/model";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";
import { imageGen } from "./tools/image-gen";
import { websearch } from "./tools/web-search";
import { compactHistory, isOverflow } from "./compaction";
import { injectSystemContext } from "./system-context";
import { logUsage } from "@/utils/format";
import { workspaceTools } from "@/workspace/tool";
import { memoryReview } from "./background-review";
import { createReplySession } from "./reply";
import type { MessagePart } from "@/message/parts";

const MEMORY_REVIEW_INTERVAL = 10;

async function loadHistory(): Promise<ChatHistory> {
  try {
    const raw = JSON.parse(await readFile(dataPath("planner.json"), "utf8"));
    return migrateHistory(raw);
  } catch {
    return [];
  }
}

async function saveHistory(history: ChatHistory, log: PinoLogger = logger) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("planner.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    log.error({ error }, "保存规划层历史失败");
  }
}

/**
 * 运行规划层
 * @param userInputMessage 已用 <user_input> 标签包好的用户消息
 * @param onReply 实际发送消息的回调
 * @returns 本轮是否通过 submit_plan 向用户发送过消息
 */
export async function runPlanner(
  userInputMessage: string,
  onReply: (segments: MessagePart[]) => Promise<void>,
  log: PinoLogger = logger,
): Promise<boolean> {
  const model = getModel(config.models.plan);
  const historyMessages: ChatHistory = await loadHistory();
  const { records } = await injectSystemContext(historyMessages, userInputMessage, log);
  const runtimeMessages: ChatHistory = [...records];

  const reasoning: string[] = [];
  let replyCount = 0;
  let replySessionPromise: ReturnType<typeof createReplySession> | undefined;
  let replyQueue = Promise.resolve();

  const { default: planPrompt } = await import("../prompts/plan.txt");
  const { default: capabilitiesPrompt } = await import("../prompts/capabilities.txt");
  const { default: workspacePrompt } = await import("../workspace/memory.txt");
  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");

  const system = [
    "<role>",
    planPrompt.trim(),
    "",
    "`submit_plan` 会返回 `reply agent` 的思维过程和实际发送给用户的消息内容。调用它表示本轮规划已经完成；工具执行后程序会直接结束本轮，不再向你发起模型请求。",
    "</role>",
    "",
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    "下面为 `reply agent` 的角色设定：",
    "<reply_role>",
    replyPrompt.trim(),
    "</reply_role>",
    "",
    "<workspace_instructions>",
    workspacePrompt.trim(),
    "</workspace_instructions>",
  ].join("\n");

  const submitPlanTool = tool({
    description:
      "根据回复策略调用 reply agent 向用户发送一条消息。工具返回 reply agent 的思维过程与实际发送内容；调用后本轮规划结束，不会再进行模型请求。",
    inputSchema: z.object({
      plan: z.string().describe("回复策略与参考信息，需具体、准确并足以让 reply agent 独立完成消息"),
    }),
    execute({ plan }) {
      const currentReasoning = reasoning.join("\n");
      const replyTask = replyQueue.then(async () => {
        replySessionPromise ??= createReplySession(userInputMessage, onReply, log);
        const { replyText, reasoningText } = await (await replySessionPromise).send(plan, currentReasoning);
        if (replyText) replyCount++;
        return [
          "<reply_result>",
          "<reasoning>",
          reasoningText,
          "</reasoning>",
          "<content>",
          replyText,
          "</content>",
          "</reply_result>",
        ].join("\n");
      });
      replyQueue = replyTask.then(
        () => undefined,
        () => undefined,
      );
      return replyTask;
    },
  });

  const tools: ToolSet = { ...workspaceTools, submit_plan: submitPlanTool };
  tools.image_gen = imageGen(tools, system, model);
  tools.web_search = websearch();
  const startMemoryReview = memoryReview(tools, system, model, log);

  const result = await generateText({
    model,
    instructions: system,
    messages: toModelMessages([...historyMessages, ...runtimeMessages]),
    tools,
    stopWhen: [isStepCount(10), hasToolCall("submit_plan")],
    maxOutputTokens: 4096,
    async onLanguageModelCallEnd({ content }) {
      const reasoningText = content
        .filter((part) => part.type === "reasoning")
        .map((part) => part.text)
        .join("");
      const text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      log.info({ reasoningText, text }, "plan响应");
      if (reasoningText) reasoning.push(reasoningText);
    },
    onToolExecutionStart({ toolCall }) {
      log.info({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input }, "工具调用");
    },
    onToolExecutionEnd({ toolCall }) {
      log.info({ toolName: toolCall.toolName }, "工具执行结束");
    },
    onStepEnd(stepResult) {
      for (const [index, message] of stepResult.response.messages.entries()) {
        const timestamp = Date.now();
        const messageUsage = index === 0 ? stepResult.usage : undefined;
        runtimeMessages.push({ message, timestamp, usage: messageUsage });
      }
    },
  });

  logUsage(log, result.usage);
  if (replyCount > 0) {
    runtimeMessages.push({
      message: { role: "assistant", content: "[Done]" },
      timestamp: Date.now(),
    });
  }
  let finalHistory: ChatHistory = [...historyMessages, ...runtimeMessages];
  if (isOverflow(result.usage)) {
    log.info("检测到上下文溢出，开始执行压缩...");
    finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
  }
  await saveHistory(finalHistory, log);

  const userTurn = records.findLast((record) => record.user_turn !== undefined)?.user_turn;
  if (replyCount > 0 && userTurn !== undefined && userTurn % MEMORY_REVIEW_INTERVAL === 0) {
    startMemoryReview(finalHistory);
  }

  return replyCount > 0;
}
