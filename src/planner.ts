import { generateText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { provider } from "./model";
import { dataPath } from "./utils/path";
import { ImageGeneration } from "./tool";
import plannerSystemPrompt from "../prompts/planner.md";
import personaSystemPrompt from "../prompts/贤惠幼妻仙狐小姐.md";

const model = provider("deepseek-v4-flash");

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

async function savePlannerHistory(history: ModelMessage[]) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("planner.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("保存规划层历史失败:", error);
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
export async function runPlanner(userInputMessage: string): Promise<PlannerResult> {
  const history = await loadPlannerHistory();
  const messages: ModelMessage[] = [...history, { role: "user", content: userInputMessage }];

  let planText = "";
  let toolCallId: string | undefined;

  for (let step = 0; step < 10; step++) {
    const result = await generateText({
      model,
      system: [plannerSystemPrompt, personaSystemPrompt].join("\n"),
      messages,
      tools: { submit_plan: submitPlanTool, generate_image: ImageGeneration },
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
      },
    });

    if (result.reasoning) console.log("内部思考: ", result.reasoning);
    if (result.text) console.log("助手响应: ", result.text);

    messages.push(...result.response.messages);

    const submitCall = result.toolCalls.find((tc) => tc.toolName === "submit_plan");
    if (submitCall) {
      planText = (submitCall.input as { plan?: string }).plan ?? "";
      toolCallId = submitCall.toolCallId;
      break;
    }

    if (result.toolCalls.length === 0) break;
  }

  console.log("规划层 plan:", planText);

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
      { role: "assistant", content: "over" },
    );
    await savePlannerHistory(finalMessages);
  };

  return { plan: planText, submitReply };
}
