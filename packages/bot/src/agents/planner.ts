import { type ChatHistory, migrateHistory, toModelMessages } from "./chat-history";
import { generateText, isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getModelForRole } from "@/agents/model";
import { dataPath, projectPath } from "@/utils/path";
import { logger, type PinoLogger } from "@/logger";
import { task } from "./tools/task";
import { webfetch } from "./tools/web-fetch";
import { websearch } from "./tools/web-search";
import { compactHistory, isOverflow } from "./compaction";
import { injectSystemContext } from "./system-context";
import { logUsage } from "@/utils/format";
import { workspaceTools } from "@/workspace/tool";
import { memoryReview } from "./background-review";
import { createReplySession } from "./reply";
import type { ReplyOutput } from "@/message/parts";

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
 * 运行允许 submit_plan 返回后继续工具循环的规划层。
 * @param userInputMessage 已用 <user_input> 标签包好的用户消息
 * @param onReply 实际发送消息的回调
 * @returns 本轮是否通过 submit_plan 向用户发送过消息
 */
export async function runPlanner(
  userInputMessage: string,
  onReply: (output: ReplyOutput) => Promise<void>,
  log: PinoLogger = logger,
): Promise<boolean> {
  const model = getModelForRole("plan");
  const historyMessages: ChatHistory = await loadHistory();
  const { records } = await injectSystemContext(historyMessages, userInputMessage, log);
  const runtimeMessages: ChatHistory = [...records];

  let reasoning = "";
  let replyCount = 0;
  let replySessionPromise: ReturnType<typeof createReplySession> | undefined;
  let replyQueue = Promise.resolve();

  const { default: planPrompt } = await import("../prompts/plan.txt?raw");
  const { default: capabilitiesPrompt } = await import("../prompts/capabilities.txt?raw");
  const { default: workspacePrompt } = await import("../workspace/memory.txt?raw");
  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");

  const system = [
    "<role>",
    planPrompt.trim(),
    "",
    "`submit_plan` 会返回 `reply agent` 实际发送给用户的消息内容。你可以据此判断消息是否准确表达了意图，以及是否需要采取后续行动。调用它不会结束本轮工具循环；你可以继续使用其他工具，并在确有必要时再次调用 `submit_plan` 发送后续消息。不要无意义地重复发送相同内容。任务完成后停止调用工具并结束。",
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
      "根据回复策略调用 reply agent 向用户发送一条消息。工具返回实际发送内容，供你判断后续行动；调用后可以继续使用其他工具，必要时也可以再次发送。",
    inputSchema: z.object({
      plan: z.string().describe("回复策略与参考信息，需具体、准确并足以让 reply agent 独立完成消息"),
    }),
    execute({ plan }) {
      const currentReasoning = reasoning;
      const replyTask = replyQueue.then(async () => {
        replySessionPromise ??= createReplySession(userInputMessage, onReply, log);
        const { replyText } = await (await replySessionPromise).send(plan, currentReasoning);
        if (replyText) replyCount++;
        return ["<reply_result>", "<content>", replyText, "</content>", "</reply_result>"].join("\n");
      });
      replyQueue = replyTask.then(
        () => undefined,
        () => undefined,
      );
      return replyTask;
    },
  });

  const tools: ToolSet = { ...workspaceTools, submit_plan: submitPlanTool };
  tools.task = task(log);
  // tools.image_gen = imageGen(tools, system, model);
  tools.web_search = websearch();
  tools.web_fetch = webfetch();
  const startMemoryReview = memoryReview(tools, system, model, log);

  const result = await generateText({
    model,
    instructions: system,
    messages: toModelMessages([...historyMessages, ...runtimeMessages]),
    tools,
    stopWhen: isStepCount(10),
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
      log.info({ reasoningText, text }, "plan响应");
      logUsage(log, usage);
      if (reasoningText) reasoning = reasoningText;
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

  let finalHistory: ChatHistory = [...historyMessages, ...runtimeMessages];
  if (isOverflow(result.finalStep.usage)) {
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
