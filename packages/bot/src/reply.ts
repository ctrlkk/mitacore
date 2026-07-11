import { generateText, type LanguageModelUsage, type ModelMessage } from "ai";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { getModel } from "@/model";
import { parseMarkdown, type MessagePart } from "@/images";
import { splitMessage } from "@/utils/message-splitter";
import { dataPath } from "@/utils/path";
import { config } from "@/config";

async function loadExecutorHistory(): Promise<ModelMessage[]> {
  try {
    const history = await readFile(dataPath("chat.json"), "utf8");
    return JSON.parse(history);
  } catch {
    return [];
  }
}

async function saveExecutorHistory(history: ModelMessage[]) {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeFile(dataPath("chat.json"), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("保存执行层历史失败:", error);
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
 * 运行回复层（仙狐小姐 persona）
 * @param userPrompt 已用 <user_input> 标签包好的用户消息
 * @param plan 规划层生成的策略
 * @param onReply 实际发送消息的回调
 * @returns replyText（拼接所有 step 的文本）+ usage
 */
export async function runReply(
  userPrompt: string,
  plan: string,
  onReply: (segments: MessagePart[]) => Promise<void>,
): Promise<{ replyText: string; usage: LanguageModelUsage | undefined }> {
  const historyMessages: ModelMessage[] = await loadExecutorHistory();
  historyMessages.push(
    { role: "user", content: userPrompt },
    {
      role: "user",
      content:
        "你正在聊天，上面是正在聊的内容，其中包含聊天记录和聊天中的图片。\n" +
        "回复尽量简短一些。请注意把握聊天内容。\n" +
        "请考虑对方的发言频率，想法，思考自己何时回复以及回复内容。\n\n" +
        "参考下方plan信息进行回复，但视情况而定，无需完全遵守.\n" +
        `<reply_plan>\n${plan}\n</reply_plan>`,
    },
  );
  const runtimeMessages: ModelMessage[] = [];
  const model = getModel(config.models.reply);

  let usage: LanguageModelUsage | undefined;
  let replyText = "";

  const { default: prompt } = await import("@prompts/role.txt");
  const { default: capabilitiesPrompt } = await import("./prompts/capabilities.txt");

  const system = [
    "<role>",
    prompt.trim(),
    "</role>",
    "",
    "<capabilities>",
    capabilitiesPrompt.trim(),
    "</capabilities>",
  ].join("\n");

  for (let step = 0; step < 20; step++) {
    const result = await generateText({
      model,
      system,
      messages: [...historyMessages, ...runtimeMessages],
    });

    if (result.reasoning) console.log("内部思考: ", result.reasoning);
    if (result.text) console.log("助手响应: ", result.text);
    if (result.text) {
      const segments = await sliceReply(result.text);
      await onReply(segments);
      const sentText = segments
        .map((seg) => {
          if (typeof seg === "string") return seg;
          return seg.raw;
        })
        .join("\n");
      // 修剪assistant消息
      const firstMsg = result.response.messages[0];
      if (firstMsg && firstMsg.role === "assistant") firstMsg.content = sentText;
      // 收集reply文本
      replyText += sentText;
    }
    usage = result.usage;
    runtimeMessages.push(...result.response.messages);

    if (result.toolCalls.length === 0) break;
  }

  // 保存：historyMessages 去掉结尾的 plan + runtimeMessages
  await saveExecutorHistory([...historyMessages.slice(0, -1), ...runtimeMessages]);
  return { replyText, usage };
}
