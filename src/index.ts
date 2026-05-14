import OpenAI from "openai";
import { access, readFile, writeFile } from 'fs/promises'
import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import systemPrompt from "../prompts/米拉3.md"

const channel = createLarkChannel({
  appId: process.env.FEISHU_BOT1_APP_ID!,
  appSecret: process.env.FEISHU_BOT1_APP_SECRET!,
});

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

async function loadHistory(chatId: string): Promise<ChatCompletionMessageParam[]> {
  try {
    const data = await readFile(".cache/messages.json", "utf8");
    return JSON.parse(data);
  }
  catch {
    return [];
  }
}

async function saveHistory(chatId: string, messages: ChatCompletionMessageParam[]) {
  await writeFile(".cache/messages.json", JSON.stringify(messages, null, 2));
}

channel.on("message", async (msg) => {
  console.log("<- 收到消息：" + msg.content);

  const messages: ChatCompletionMessageParam[] = await loadHistory(msg.chatId);
  messages.unshift({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: msg.content });

  const stream = await openai.chat.completions.create({
    model: "deepseek-v4-pro",
    reasoning_effort: "xhigh",
    messages: messages,
    stream: true,
  });

  let fullContent = "";
  let reasoningContent = "";

  await channel.stream(msg.chatId, {
    markdown: async (controller) => {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        const reasoningDelta = (delta as any).reasoning_content as string | undefined;
        if (reasoningDelta) {
          reasoningContent += reasoningDelta;
        }

        if (delta.content) {
          fullContent += delta.content;
          await controller.append(delta.content);
        }

        if (chunk.usage) {
          const usage = chunk.usage;
          await controller.append(`\n\n` + `\`total${usage.total_tokens} prompt${usage.prompt_tokens} output${usage.completion_tokens}\``)
        }
      }
    },
  });
  
  console.log("推理内容:", reasoningContent);
  console.log("正文:", fullContent);

  messages.push({ role: "assistant", content: fullContent });
  messages.shift();
  await saveHistory(msg.chatId, messages);
});

channel.on("error", (err) => {
  console.error("连接通道错误", err);
});

channel.on("reconnected", () => {
  console.log("重新连接成功！");
});

// 建立连接
channel.connect();
