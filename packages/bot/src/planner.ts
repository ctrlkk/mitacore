import { generateText, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";
import { imageGen } from "./tools/image-gen";

const submitPlanTool = tool({
  description: "提交本轮回复策略，包含语气、角度、要点、长度、工具调用等",
  inputSchema: z.object({
    plan: z.string().describe("回复策略描述，简洁可执行，不超过 200 字"),
  }),
});

async function loadPlannerHistory(): Promise<ModelMessage[]> {
  try {
    return JSON.parse(await readFile(dataPath("planner.json"), "utf8"));
  } catch {
    return [];
  }
}

async function savePlannerHistory(history: ModelMessage[], log: PinoLogger = logger) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("planner.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    log.error({ error }, "保存规划层历史失败");
  }
}

interface PlannerResult {
  plan: string;
  /** 由执行层调用：用实际回复替换规划结束标记并落盘 */
  submitReply: (replyText: string) => Promise<void>;
}

/**
 * 运行规划层
 * @param userInputMessage 已用 <user_input> 标签包好的用户消息
 * @returns plan + submitReply 回调（调用后把完整 messages 持久化到 .cache/planner.json）
 */
export async function runPlanner(userInputMessage: string, log: PinoLogger = logger): Promise<PlannerResult> {
  const history = await loadPlannerHistory();
  const messages: ModelMessage[] = [...history, { role: "user", content: userInputMessage }];
  const model = getModel(config.models.plan);

  let planText = "";
  let toolCallId: string | undefined;

  const { default: planPrompt } = await import("./prompts/plan.txt");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");
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

  for (let step = 0; step < 10; step++) {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
    });

    if (result.reasoning) log.info({ reasoning: result.reasoningText, step }, "内部思考");
    if (result.text) log.info({ text: result.text, step }, "助手响应");

    messages.push(...result.response.messages);

    const submitCall = result.toolCalls.find((tc) => tc.toolName === "submit_plan");
    if (submitCall) {
      planText = (submitCall.input as { plan?: string }).plan ?? "";
      toolCallId = submitCall.toolCallId;
      break;
    }

    if (result.toolCalls.length === 0) break;
  }

  log.info({ plan: planText }, "规划层 plan");

  const submitReply = async (replyText: string): Promise<void> => {
    const finalMessages: ModelMessage[] = messages;
    finalMessages.push(
      {
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
      { role: "assistant", content: "[Done]" },
    );
    await savePlannerHistory(finalMessages, log);
  };

  return { plan: planText, submitReply };
}
