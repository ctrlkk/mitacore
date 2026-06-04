import { createLarkChannel, LarkChannel } from "@larksuiteoapi/node-sdk";
import XMLBuilder from "fast-xml-builder";
import { EventEmitter } from "events";
import type { CompletionUsage, ChatCompletionMessageParam } from "openai/resources";
import { env } from "process";
import OpenAI from "openai";
import { mkdir, readFile, writeFile } from "fs/promises";
import systemPrompt1 from "../prompts/米拉.md";
import systemPrompt2 from "../prompts/善良米塔.md";
// import systemPrompt3 from "../prompts/帽子米塔.md";
import systemPrompt3 from "../prompts/贤惠幼妻仙狐小姐.md";
import dayjs from "dayjs";
import { Mutex } from "async-mutex";
import { resolve } from "path";

const builder = new XMLBuilder({
  format: true,
  ignoreAttributes: false,
});

interface ChatMessagePayload {
  id: string,
  chatId: string;
  from: string;
  type: "user" | "llm";
  datetime: string;
  content: string;
}

interface EventMap {
  chatMessage: [ChatMessagePayload];
}

const eventBus = new EventEmitter<EventMap>();

const bots = [
  {
    appId: env.FEISHU_BOT1_APP_ID || "",
    appSecret: env.FEISHU_BOT1_APP_SECRET || "",
    name: "米拉",
    prompt: systemPrompt1,
  },
  {
    appId: env.FEISHU_BOT2_APP_ID || "",
    appSecret: env.FEISHU_BOT2_APP_SECRET || "",
    name: "善良米塔",
    prompt: systemPrompt2,
  },
  {
    appId: env.FEISHU_BOT3_APP_ID || "",
    appSecret: env.FEISHU_BOT3_APP_SECRET || "",
    // name: "帽子米塔",
    name: "贤惠幼妻仙狐小姐",
    prompt: systemPrompt3,
  }
];

const mutex = new Mutex();

bots.forEach(async ({ appId, appSecret, name, prompt }, index) => {
  const channel = createLarkChannel({ appId, appSecret });
  const buffer = createReactiveBuffer(name, await loadBuffer(name));

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

    eventBus.emit("chatMessage", {
      id: appId,
      chatId: msg.chatId,
      from: "用户",
      type: "user",
      datetime: new Date(msg.createTime).toISOString(),
      content: msg.content,
    });

    buffer.push({
      id: appId,
      chatId: msg.chatId,
      from: "用户",
      datetime: new Date(msg.createTime).toISOString(),
      content: msg.content,
    });

    const message = builder.build({
      message: buffer.map((item) => {
        return {
          '@_name': item.from,
          '@_date': dayjs(item.datetime).format('MM-DD HH:mm'),
          '#text': item.content,
        }
      }),
    });

    buffer.length = 0;

    const client = new OpenAI({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_API_BASE,
    });

    const messages = await loadHistory(name);
    messages.unshift({
      role: "system",
      content: prompt,
    });
    messages.push({
      role: "user",
      content: message,
    });

    console.log("开始调用 OpenAI API");
    const response = await client.chat.completions.create({
      model: "deepseek-v4-flash",
      temperature: 1.2,
      reasoning_effort: 'xhigh',
      messages: messages,
    });
    console.log("OpenAI API 调用完成");

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

    eventBus.emit("chatMessage", {
      id: appId,
      chatId: msg.chatId,
      from: name,
      type: "llm",
      datetime: new Date().toISOString(),
      content: content,
    });

    release();
  });

  eventBus.on("chatMessage", (payload) => {
    if (appId === payload.id) return;
    console.log(`收到广播内容📢 ${payload.content}`);
    buffer.push({
      id: appId,
      chatId: payload.chatId,
      datetime: new Date().toISOString(),
      from: payload.from,
      content: payload.content,
    });
    buffer.sort((a, b) => a.datetime.localeCompare(b.datetime));
    if (buffer.length > 20) buffer.shift();
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

async function loadBuffer(name: string) {
  try {
    const data = await readFile(resolve('.cache', `${name}_buffer.json`), 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveBuffer(name: string, bufferData: { id: string, chatId: string; datetime: string; from: string; content: string; }[]) {
  try {
    await mkdir(resolve('.cache'), { recursive: true });
    await writeFile(resolve('.cache', `${name}_buffer.json`), JSON.stringify(bufferData, null, 2));
  } catch (error) {
    console.error(`保存buffer失败: ${error}`);
  }
}

function createReactiveBuffer(name: string, initialData: { id: string, chatId: string; datetime: string; from: string; content: string; }[]) {
  let saveTimer: NodeJS.Timeout | null = null;

  const scheduleSave = (target: any[]) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await saveBuffer(name, target);
    }, 500); // 500ms 防抖，合并高频操作
  };

  const handler: ProxyHandler<typeof initialData> = {
    set(target, property, value, receiver) {
      const result = Reflect.set(target, property, value, receiver);
      // 拦截赋值操作（包括 push, length = 0, sort 引起的变更）
      scheduleSave(target);
      return result;
    },
    deleteProperty(target, property) {
      const result = Reflect.deleteProperty(target, property);
      // 拦截删除操作（如 shift）
      scheduleSave(target);
      return result;
    }
  };

  return new Proxy(initialData, handler);
}
