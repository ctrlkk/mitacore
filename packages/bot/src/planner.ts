import { type ChatHistory, migrateHistory, toModelMessages } from "@/types/chat-history";
import { generateText, tool, type LanguageModelUsage, type ToolSet } from "ai";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { logger, type PinoLogger } from "@/logger";
import { imageGen } from "./tools/image-gen";
import { websearch } from "./tools/web-search";
import { compactHistory, isOverflow } from "./compaction";
import { getStickersPrompt } from "./stickers";

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
export async function runPlanner(userInputMessage: string, log: PinoLogger = logger): Promise<PlannerResult> {
  let messages: ChatHistory = await loadHistory();

  // 新增本次用户输入作为一条 record
  messages.push({
    message: { role: "user", content: userInputMessage },
    timestamp: Date.now(),
  });
  const model = getModel(config.models.plan);

  let planText = "";
  let reasoning: string[] = [];
  let toolCallId: string | undefined;

  let usage: LanguageModelUsage | undefined;

  const { default: planPrompt } = await import("./prompts/plan.txt");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");
  const replyPrompt = await readFile(projectPath("prompts", "role.txt"), "utf8");
  const stickersPrompt = await getStickersPrompt();

  const system = [
    "<role>",
    planPrompt.trim(),
    "</role>",
    "",
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
    "",
    stickersPrompt.trim(),
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
      system,
      messages: toModelMessages(messages),
      tools,
    });

    log.info({ reasoningText: result.reasoningText, text: result.text, step }, "plan响应");
    if (result.reasoningText) reasoning.push(result.reasoningText);
    usage = result.usage;

    // 把该 step 产出的消息追加为 ChatRecord，首条带 usage
    const stepMsgs = result.response.messages;
    stepMsgs.forEach((msg, i) => {
      messages.push({
        message: msg,
        timestamp: Date.now(),
        usage: i === 0 ? result.usage : undefined,
      });
    });

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
    messages.push(
      {
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
      },
      {
        message: { role: "assistant", content: "[Done]" },
        timestamp: Date.now(),
      },
    );

    if (isOverflow(usage)) {
      log.info("检测到上下文溢出，开始执行压缩...");
      messages = await compactHistory(model, system, messages, undefined, log);
    }
    await saveHistory(messages, log);
  };

  return { plan: planText, reasoning: reasoning.join("\n"), submitReply };
}
