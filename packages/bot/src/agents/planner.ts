import { type ChatHistory, migrateHistory, toModelMessages } from "./chat-history";
import { generateText, tool, type LanguageModelUsage, type ToolSet } from "ai";
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

const submitPlanTool = tool({
  description: "提交本轮回复策略，包含语气、角度、要点、长度、工具调用等",
  inputSchema: z.object({
    plan: z.string().describe("回复策略描述，简洁可执行，不超过 200 字"),
  }),
});

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

interface PlannerResult {
  plan: string;
  reasoning: string;
  /** 由执行层调用：用实际回复替换规划结束标记并落盘 */
  submitReply: (replyText: string) => Promise<void>;
}

/**
 * 运行规划层
 * @param userInputMessage 已用 <user_input> 标签包好的用户消息
 * @returns plan + submitReply 回调（调用后把完整 messages 持久化到 .cache/planner.json）
 */
export async function runPlanner(userInputMessage: string, log: PinoLogger = logger): Promise<PlannerResult | null> {
  const model = getModel(config.models.plan);
  const historyMessages: ChatHistory = await loadHistory();
  const { records } = await injectSystemContext(historyMessages, userInputMessage, log);
  const runtimeMessages: ChatHistory = [...records];

  let planText = "";
  let reasoning: string[] = [];
  let toolCallId: string | undefined;
  // v7 中 result.toolCalls 累积所有 step，需用 currentStepToolCalls 追踪每步的工具调用
  let currentStepToolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }> = [];

  let usage: LanguageModelUsage | undefined;

  const { default: planPrompt } = await import("../prompts/plan.txt");
  const { default: capabilitiesPrompt } = await import("../prompts/capabilities.txt");
  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");

  const system = [
    "<role>",
    planPrompt.trim(),
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
  ].join("\n");

  const tools: ToolSet = { submit_plan: submitPlanTool };
  tools.image_gen = imageGen(tools, system, model);
  tools.web_search = websearch();

  for (let step = 0; step < 10; step++) {
    const result = await generateText({
      model,
      instructions: system,
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
      tools,
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
        log.info({ reasoningText, text, step }, "plan响应");
        if (reasoningText) reasoning.push(reasoningText);
      },
      onToolExecutionStart({ toolCall }) {
        log.info(
          { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input, step },
          "工具调用",
        );
      },
      onToolExecutionEnd({ toolCall }) {
        log.info({ toolName: toolCall.toolName, step }, "工具执行结束");
      },
      onStepEnd(stepResult) {
        currentStepToolCalls = stepResult.toolCalls;
        for (const [index, message] of stepResult.response.messages.entries()) {
          const timestamp = Date.now();
          const messageUsage = index === 0 ? stepResult.usage : undefined;
          runtimeMessages.push({ message, timestamp, usage: messageUsage });
        }
      },
    });

    usage = result.usage;
    logUsage(log, usage);

    const submitCall = currentStepToolCalls.find((tc) => tc.toolName === "submit_plan");
    if (submitCall) {
      planText = (submitCall.input as { plan?: string }).plan ?? "";
      toolCallId = submitCall.toolCallId;
      break;
    }

    if (currentStepToolCalls.length === 0) break;
  }

  // 未调用 submit_plan，无需回复，保存当前上下文后返回 null
  if (!toolCallId) {
    log.info("规划层未调用 submit_plan，跳过回复");
    let finalHistory: ChatHistory = [...historyMessages, ...runtimeMessages];
    if (isOverflow(usage)) {
      log.info("检测到上下文溢出，开始执行压缩...");
      finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
    }
    await saveHistory(finalHistory, log);
    return null;
  }

  log.info({ plan: planText }, "规划层 plan");

  const submitReply = async (replyText: string): Promise<void> => {
    const toolRecord: ChatHistory[number] = {
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: toolCallId ?? "submit_plan",
            toolName: "submit_plan",
            output: { type: "text", value: replyText },
          },
        ],
      },
      timestamp: Date.now(),
    };
    const doneRecord: ChatHistory[number] = {
      message: { role: "assistant", content: "[Done]" },
      timestamp: Date.now(),
    };
    runtimeMessages.push(toolRecord, doneRecord);

    let finalHistory: ChatHistory = [...historyMessages, ...runtimeMessages];
    if (isOverflow(usage)) {
      log.info("检测到上下文溢出，开始执行压缩...");
      finalHistory = await compactHistory(model, system, finalHistory, undefined, log);
    }
    await saveHistory(finalHistory, log);
  };

  return { plan: planText, reasoning: reasoning.join("\n"), submitReply };
}
