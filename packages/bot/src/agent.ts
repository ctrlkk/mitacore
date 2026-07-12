import { generateText, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { parseMarkdown, type MessagePart } from "@/images";
import { splitMessage } from "@/utils/message-splitter";
import { dataPath, projectPath } from "@/utils/path";
import { config } from "@/config";
import { imageGen } from "./tools/image-gen";

async function loadMainHistory(): Promise<ModelMessage[]> {
  try {
    const history = await readFile(dataPath("history.json"), "utf8");
    return JSON.parse(history);
  } catch {
    return [];
  }
}

async function saveMainHistory(history: ModelMessage[]) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("history.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("保存单 agent 历史失败:", error);
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
export async function runMain(userPrompt: string, onReply: (segments: MessagePart[]) => Promise<void>) {
  const mainAlias = config.models.main;
  if (!mainAlias) {
    throw new Error("未配置 models.main，无法使用单 agent 模式");
  }
  const model = getModel(mainAlias);

  const historyMessages: ModelMessage[] = await loadMainHistory();
  historyMessages.push({ role: "user", content: userPrompt });
  const runtimeMessages: ModelMessage[] = [];

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

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      system,
      messages: [...historyMessages, ...runtimeMessages],
    });

    if (result.reasoning) console.log("内部思考: ", result.reasoningText);
    if (result.text) console.log("助手响应: ", result.text);
    if (result.text) {
      const segments = await sliceReply(result.text);
      await onReply(segments);
    }
    usage = result.usage;
    runtimeMessages.push(...result.response.messages);

    if (result.toolCalls.length === 0) break;
  }

  await saveMainHistory([...historyMessages, ...runtimeMessages]);
  return { usage };
}
