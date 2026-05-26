import { createLarkChannel, LarkChannel } from "@larksuiteoapi/node-sdk";
import XMLBuilder from "fast-xml-builder";
import { EventEmitter } from "events";
import type { CompletionUsage, ChatCompletionMessageParam } from "openai/resources";
import { env } from "process";
import OpenAI from "openai";
import { mkdir, readFile, writeFile } from "fs/promises";
import systemPrompt1 from "../prompts/阿丽亚.md";
import { Mutex } from "async-mutex";
import { resolve } from "path";

const bots = [
  {
    appId: env.FEISHU_BOT4_APP_ID || "",
    appSecret: env.FEISHU_BOT4_APP_SECRET || "",
    name: "阿丽亚",
    prompt: systemPrompt1,
  },
];

const mutex = new Mutex();

bots.forEach(async ({ appId, appSecret, name, prompt }, index) => {
  const channel = createLarkChannel({ appId, appSecret });

  async function sendCard(chatId: string, reasoning: string, usage: CompletionUsage) {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "💭 思维链" } },
      elements: [
        {
          tag: "markdown",
          content: `<font color="grey">${reasoning}\ntokens:${usage?.total_tokens}</font>`,
        },
      ],
    };
    await channel.send(chatId, { card });
  }

  channel.on("message", async (msg) => {
    const release = await mutex.acquire();

    const openai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://new.mitacore.fun/v1",
    });

    const messages = await loadHistory(name);
    messages.unshift({
      role: "system",
      content: prompt,
    });
    messages.push({
      role: "user",
      content: msg.content,
    });

    const response = await openai.chat.completions.create({
      model: "deepseek-v4-flash",
      temperature: 1.2,
      reasoning_effort: 'xhigh',
      messages: messages,
    });

    const choice = response.choices[0]!;
    // @ts-ignore
    const reasoning = choice.message.reasoning_content || "";
    await sendCard(msg.chatId, reasoning, response.usage!);

    const content = choice.message.content || "";
    await channel.send(msg.chatId, {
      card: {
        elements: [
          {
            tag: "markdown",
            content: content
              .replace(/[（(](.*?)[)）]/g, '<font color="grey">（$1）</font>')
              .replace(/[“「](.*?)[”」]/g, '“$1”'),
          },
        ],
      }
    });

    messages.push({
      role: "assistant",
      content: content,
    });
    messages.shift();
    await saveHistory(name, messages);

    release();
  });

  await channel.connect();
});

async function loadHistory(name: string): Promise<ChatCompletionMessageParam[]> {
  try {
    const history = await readFile(resolve('.cache', `${name}.json`), 'utf8');
    return JSON.parse(history);
  } catch {
    return [];
  }
}

async function saveHistory(name: string, history: ChatCompletionMessageParam[]) {
  try {
    await mkdir(resolve('.cache'), { recursive: true });
    await writeFile(resolve('.cache', `${name}.json`), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error(`保存历史记录失败: ${error}`);
  }
}