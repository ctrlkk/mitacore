import type { ChatCompletionMessageParam } from 'openai/resources';
import { raw, SnowLumaWebSocketClient } from '@snowluma/sdk';
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
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { Mutex } from 'async-mutex';

dayjs.locale('zh-cn');

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

interface UnifiedTextMessage {
    type: "text";
    text: string;
}

interface UnifiedAtMessage {
    type: "at";
    data: { id: string; nickname: string };
}

interface UnifiedImageMessage {
    type: "image";
    data: { url: string };
}

interface UnifiedReplyMessage {
    type: "reply";
    data: { id: string; nickname: string; segments: UnifiedInboundMessage[] };
}

type UnifiedInboundMessage = UnifiedTextMessage | UnifiedAtMessage | UnifiedImageMessage | UnifiedReplyMessage;

async function convertOneBotToUnified(
    segments: MessageSegment[],
    getNickname: (qq: number) => Promise<string | null | undefined>,
    getMessage: (id: number) => Promise<{ userId: number; message: MessageSegment[] } | null>,
): Promise<UnifiedInboundMessage[]> {
    const messages: UnifiedInboundMessage[] = [];
    for (const seg of segments) {
        if (seg.type === "text") {
            messages.push({ type: "text", text: seg.data.text });
        } else if (seg.type === "at") {
            const nickname = await getNickname(Number(seg.data.qq));
            messages.push({ type: "at", data: { id: seg.data.qq, nickname: nickname ?? "" } });
        } else if (seg.type === "image") {
            messages.push({ type: "image", data: { url: seg.data.url } });
        } else if (seg.type === "reply") {
            const result = await getMessage(Number(seg.data.id));
            let inner: UnifiedInboundMessage[] = [];
            let nickname = "";
            if (result) {
                const resolved = await getNickname(result.userId);
                nickname = resolved ?? "";
                inner = await convertOneBotToUnified(result.message, getNickname, () => Promise.resolve(null));
            }
            messages.push({ type: "reply", data: { id: seg.data.id, nickname, segments: inner } });
        }
    }
    return messages;
}

async function convertUnifiedToLlm(messages: UnifiedInboundMessage[]) {
    const images: { "@_path": string; "#text": string }[] = [];
    const parts: string[] = [];
    for (const msg of messages) {
        if (msg.type === "text") {
            parts.push(msg.text);
        } else if (msg.type === "at") {
            if (msg.data.nickname) {
                parts.push("@" + msg.data.nickname);
            }
        } else if (msg.type === "image") {
            const { path, description } = await cacheImage(msg.data.url);
            images.push({ "@_path": path, "#text": description });
            parts.push(`\`${path}\``);
        } else if (msg.type === "reply") {
            const inner = await convertUnifiedToLlm(msg.data.segments);
            images.push(...inner.images);
            const text = inner.parts.join("").trim();
            if (text) {
                parts.push(`<reply nickname="${msg.data.nickname}">${text}</reply>`);
            }
        }
    }
    return { parts, images };
}

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

async function cacheImage(url: string) {
    const blob = await download(url);
    const buffer = Buffer.from(await blob.bytes());
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 5);
    const ext = extension(blob.type) || "jpg";
    const filename = `${hash}.${ext}`;
    const dir = resolve(".cache", "images");
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, filename), buffer);
    const description = await imageToText(url);
    return { path: `/images/${filename}`, description };
}

async function main() {
    const bot = new SnowLumaWebSocketClient({
        url: 'ws://127.0.0.1:3001/',
        accessToken: 'your_token',
        reconnect: true,
    });

    const mutex = new Mutex();

    bot.onMessage(async (event, ctx) => {
        const segments = event.message as unknown as MessageSegment[];
        if (event.message_type === "group") {
            if (event.group_id !== 761178785) {
                return;
            }
            const isAtBot = segments.some(seg => seg.type === "at" && seg.data.qq === "2790285434");
            if (!isAtBot) return;
        }
        if (event.message_type === "private") {
            if (event.user_id !== 2870245624) {
                return;
            }
        }
        const unified = await convertOneBotToUnified(
            segments,
            async (qq) => {
                if (event.message_type === "group") {
                    const { nickname } = await ctx.client.getGroupMemberInfo(Number(event.group_id), qq);
                    return nickname as string;
                }
                const { nickname } = await ctx.client.getStrangerInfo(qq);
                return nickname as string;
            },
            async (id) => {
                const { user_id, message } = await ctx.client.getMessage(Number(id));
                return { userId: user_id as number, message: message as unknown as MessageSegment[] };
            },
        );
        const { parts, images } = await convertUnifiedToLlm(unified);

        let prompt = parts.join("").trim();
        if (!prompt) return;

        const release = await mutex.acquire();

        try {
            const nickname = event.sender.nickname;
            const date = dayjs(event.time * 1000).format('YYYY-MM-DD dddd HH:mm');
            prompt = `<user_input date="${date}" nickname="${nickname}">\n${prompt}\n</user_input>`

            if (event.sender.user_id !== 2870245624) {
                prompt = "收到一条路人的消息\n" + prompt;
            }

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
                model: "deepseek-v4-pro",
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
                console.log(usage);
                if (choice.message.content) {
                    const parts = await parseMarkdown(choice.message.content);
                    for (const part of parts) {
                        if (typeof part === 'string') {
                            for (const line of part.split('\n')) {
                                if (!line.trim()) continue;
                                await ctx.reply(line);
                                await Bun.sleep(500);
                            }
                        }
                        else {
                            await ctx.reply(part);
                            await Bun.sleep(1000);
                        }
                    }
                }
            });

            await saveHistory("chat", fullMessages);
            if ((usage?.total_tokens || 0) < 64000) {
                return;
            }
            await summary(fullMessages);
        }
        finally {
            release();
        }
    });

    await bot.connect();
    console.log('已连接');
}

main().catch(console.error);
