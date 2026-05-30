import type { ChatCompletionMessageParam } from 'openai/resources';
import { raw, SnowLumaWebSocketClient } from '@snowluma/sdk';
import { marked, type Token, type Tokens } from 'marked';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, parse, join } from 'node:path';
import { createHash } from 'node:crypto';
import { extension } from 'mime-types';
import { download } from './utils/blob';
import { env } from 'node:process';
import { Agent } from './agent';
import { imageToText } from './multimedia';
import { parseMarkdown, renderStickers } from './images';
import OpenAI from 'openai';
import XMLBuilder from 'fast-xml-builder';
import systemPrompt from "../prompts/贤惠幼妻仙狐小姐.md";
import summaryPrompt from "../prompts/summary.md";

interface TextSegment {
    type: "text";
    data: { text: string };
}

interface ImageSegment {
    type: "image";
    data: { file: string; file_size?: number | string; url: string };
}

interface VideoSegment {
    type: "video";
    data: { file: string; file_size?: number | string; url: string };
}

interface RecordSegment {
    type: "record";
    data: { file: string; file_size?: number | string; url: string };
}

interface AtSegment {
    type: "at";
    data: { qq: string };
}

interface FaceSegment {
    type: "face";
    data: Record<string, unknown>;
}

interface ReplySegment {
    type: "reply";
    data: { id: string };
}

interface FileSegment {
    type: "file";
    data: { file: string; file_name?: string; file_size?: number | string; url?: string };
}

type MessageSegment = TextSegment | ImageSegment | VideoSegment | RecordSegment | AtSegment | FaceSegment | ReplySegment | FileSegment;

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

const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_API_BASE,
});

const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
});

async function summary(fullMessages: ChatCompletionMessageParam[]) {
    const completion = await client.chat.completions.create({
        model: "deepseek-v4-flash",
        messages: [
            { role: "system", content: systemPrompt },
            ...fullMessages,
            { role: "user", name: "summary", content: `<system>${summaryPrompt}</system>` },
        ],
    });
    const summaryText = completion.choices[0]?.message.content || "";
    await saveHistory("chat", [{ role: "user", content: `<summary>${summaryText}</summary>` }]);
}

async function main() {
    const bot = new SnowLumaWebSocketClient({
        url: 'ws://127.0.0.1:3001/',
        accessToken: 'your_token',
        reconnect: true,
    });

    bot.onMessage(async (event, ctx) => {
        if (event.message_type === "group") return;
        if (event.user_id !== 2870245624) return;
        const segments = event.message as unknown as MessageSegment[];

        const images: { "@_path": string, "#text": string }[] = [];
        const parts: string[] = [];
        for (const seg of segments) {
            if (seg.type === "text") {
                parts.push(seg.data.text);
            }
            else if (seg.type === "image") {
                const url = seg.data.url;
                const blob = await download(url);
                const buffer = Buffer.from(await blob.bytes());
                const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 5);
                const ext = extension(blob.type) || "jpg";
                const filename = `${hash}.${ext}`;
                const dir = resolve(".cache", "images");
                await mkdir(dir, { recursive: true });
                await writeFile(resolve(dir, filename), buffer);
                const description = await imageToText(url);
                images.push({ "@_path": `/images/${filename}`, "#text": description });
                parts.push(`\`/images/${filename}\``);
            }
        }

        let prompt = parts.join("").trim();
        if (!prompt) return;

        prompt = `<user_input>\n${prompt}\n</user_input>`

        if (images.length > 0) {
            const reminder = builder.build({
                "system_reminder": {
                    "#text": "由于模型不支持图像输入，下面是对话中对应图像的文字描述。\n",
                    "image": images
                }
            }).trim();
            prompt = [reminder, prompt].join("\n\n");
        }

        console.log(`收到消息: ${prompt}`);

        const messages = await loadHistory("chat");

        const stickerPrompt = await renderStickers('stickers');

        messages.push({ role: "user", content: prompt });

        const agent = new Agent({
            client,
            model: "deepseek-v4-flash",
            systemPrompt: [systemPrompt.trim(), stickerPrompt.trim()].join("\n\n"),
            messages,
            temperature: 2,
            tools: {},
            context: null,
            maxSteps: 5,
        });

        const { fullMessages, usage } = await agent.run(async ({ choice }) => {
            console.log(choice.message.reasoning_content);
            console.log(choice.message.content);
            if (choice.message.content) {
                const parts = await parseMarkdown(choice.message.content);
                for (const part of parts) {
                    await ctx.reply(part);
                    await Bun.sleep(1000);
                }
            }
        });

        await saveHistory("chat", fullMessages);
        if ((usage?.total_tokens || 0) < 64000) {
            return;
        }
        await summary(fullMessages);
    });

    await bot.connect();
    console.log('已连接');
}

main().catch(console.error);
