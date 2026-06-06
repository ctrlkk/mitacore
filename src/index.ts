import type { ChatCompletionMessageParam } from 'openai/resources';
import type { OneBotMessageEvent, OneBotMessageSegment } from './onebot/websocket-client';
import { OneBotClient, type OneBotEventContext } from './onebot/onebot-client';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, parse } from 'node:path';
import { createHash } from 'node:crypto';
import { extension } from 'mime-types';
import { download } from './utils/blob';
import { env } from 'node:process';
import { Agent } from './agent';
import { imageToText } from './multimedia';
import { parseMarkdown, renderStickers, type MessagePart } from './images';
import { Mutex } from 'async-mutex';
import { tool } from './tool';
import { z } from 'zod';
import OpenAI from 'openai';
import XMLBuilder from 'fast-xml-builder';
import systemPrompt from "../prompts/贤惠幼妻仙狐小姐.md";
import summaryPrompt from "../prompts/summary.md";
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

interface UnifiedTextMessage { type: "text"; text: string; }
interface UnifiedAtMessage { type: "at"; data: { id: string; nickname: string }; }
interface UnifiedImageMessage { type: "image"; data: { url: string }; }
interface UnifiedReplyMessage { type: "reply"; data: { id: string; nickname: string; segments: UnifiedInboundMessage[] }; }
type UnifiedInboundMessage = UnifiedTextMessage | UnifiedAtMessage | UnifiedImageMessage | UnifiedReplyMessage;

interface PendingMessage {
    unifiedMessages: UnifiedInboundMessage[];
    nickname: string;
    date: string;
    ctx: OneBotEventContext<OneBotMessageEvent>;
    isMaster: boolean;
}

async function convertOneBotToUnified(
    segments: OneBotMessageSegment[],
    getNickname: (qq: number) => Promise<string | null | undefined>,
    getMessage: (id: number) => Promise<{ userId: number; message: OneBotMessageSegment[] } | null>,
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

async function processImages(urls: string[]): Promise<Map<string, { path: string; description: string }>> {
    const resultMap = new Map<string, { path: string; description: string }>();
    if (urls.length === 0) return resultMap;

    const downloadTasks = urls.map(async (url) => {
        try {
            const blob = await download(url);
            const buffer = Buffer.from(await blob.bytes());
            const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 8);
            const ext = extension(blob.type) || "jpg";
            const filename = `${hash}.${ext}`;
            const path = `/images/${filename}`;
            
            const dir = resolve(".cache", "images");
            await mkdir(dir, { recursive: true });
            await writeFile(resolve(dir, filename), buffer);
            
            return { url, path, success: true as const };
        } catch (error) {
            console.error(`下载图片失败: ${url}`, error);
            return { url, path: "", success: false as const };
        }
    });
    const downloaded = await Promise.all(downloadTasks);

    const uniquePaths = new Map<string, string>(); 
    for (const item of downloaded) {
        if (item.success && !uniquePaths.has(item.path)) {
            uniquePaths.set(item.path, item.url);
        }
    }

    const descriptionTasks = Array.from(uniquePaths.entries()).map(async ([path, url]) => {
        try {
            const description = await imageToText(url);
            return { path, description };
        } catch (error) {
            console.error(`图片转述失败: ${path}`, error);
            return { path, description: "[图片转述失败]" };
        }
    });
    const descriptions = await Promise.all(descriptionTasks);
    const pathToDesc = new Map(descriptions.map(d => [d.path, d.description]));

    for (const item of downloaded) {
        if (item.success) {
            resultMap.set(item.url, {
                path: item.path,
                description: pathToDesc.get(item.path) || "[未知图片]"
            });
        } else {
            resultMap.set(item.url, { path: "", description: "[图片加载失败]" });
        }
    }

    return resultMap;
}

function renderSegments(
    segments: UnifiedInboundMessage[], 
    imageMap: Map<string, { path: string; description: string }>
): { text: string; images: { "@_path": string; "#text": string }[] } {
    const parts: string[] = [];
    const images: { "@_path": string; "#text": string }[] = [];

    for (const seg of segments) {
        if (seg.type === "text") {
            parts.push(seg.text);
        } else if (seg.type === "at") {
            if (seg.data.nickname) parts.push(`@${seg.data.nickname}`);
        } else if (seg.type === "image") {
            const img = imageMap.get(seg.data.url);
            if (img && img.path) {
                parts.push(`\`${img.path}\``);
                images.push({ "@_path": img.path, "#text": img.description });
            } else {
                parts.push("[图片]");
            }
        } else if (seg.type === "reply") {
            const inner = renderSegments(seg.data.segments, imageMap);
            images.push(...inner.images);
            if (inner.text.trim()) {
                parts.push(`<reply nickname="${seg.data.nickname}">${inner.text.trim()}</reply>`);
            }
        }
    }
    return { text: parts.join(" "), images };
}

function renderBatchToPrompt(
    batch: PendingMessage[], 
    imageMap: Map<string, { path: string; description: string }>
): string {
    const promptParts: string[] = [];
    const allImages: { "@_path": string; "#text": string }[] = [];

    for (const msg of batch) {
        // 渲染组装
        const { text, images } = renderSegments(msg.unifiedMessages, imageMap);
        allImages.push(...images);
        
        let block = `<user_input date="${msg.date}" nickname="${msg.nickname}">\n${text}\n</user_input>`;
        if (!msg.isMaster) block = "收到一条路人的消息\n" + block;
        promptParts.push(block);
    }

    const uniqueImagesMap = new Map<string, { "@_path": string; "#text": string }>();
    for (const img of allImages) uniqueImagesMap.set(img["@_path"], img);
    const uniqueImages = Array.from(uniqueImagesMap.values());

    let finalPrompt = promptParts.join("\n\n");

    const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
    if (uniqueImages.length > 0) {
        const reminder = builder.build({
            "system_reminder": {
                "#text": "由于模型不支持图像输入，下面是对话中对应图像的文字描述。\n",
                "image": uniqueImages
            }
        }).trim();
        finalPrompt = `${reminder}\n\n${finalPrompt}`;
    }

    return finalPrompt;
}

async function loadHistory(name: string): Promise<ChatCompletionMessageParam[]> {
    try {
        const history = await readFile(resolve('.cache', `${name}.json`), 'utf8');
        return JSON.parse(history);
    } catch { return []; }
}

async function saveHistory(name: string, history: ChatCompletionMessageParam[]) {
    try {
        await mkdir(resolve('.cache'), { recursive: true });
        await writeFile(resolve('.cache', `${name}.json`), JSON.stringify(history, null, 2));
    } catch (error) { console.error(`保存历史记录失败: ${error}`); }
}

const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_API_BASE,
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
    console.log("摘要:", summaryText);
    await saveHistory("chat", [{ role: "user", content: `<summary>${summaryText}</summary>` }]);
}

async function loadImageBlob(ref: string): Promise<{ blob: Blob; filename: string }> {
    if (ref.startsWith("/images/")) {
        const name = ref.slice("/images/".length);
        const buffer = await readFile(resolve(".cache", "images", name));
        const ext = parse(name).ext.slice(1);
        const mime = ext === "jpg" ? "jpeg" : ext;
        return { blob: new Blob([buffer], { type: `image/${mime}` }), filename: name };
    }
    const blob = await download(ref);
    const filename = parse(new URL(ref).pathname).base || "ref";
    return { blob, filename };
}

const imageGenerationTool = tool({
    description: "根据输入的描述生成图像，当需要视觉内容创作时使用。",
    inputSchema: z.object({
        prompt: z.string().describe("用于生成图像的提示词内容"),
        images: z.array(z.string()).describe("可选的用于图像生成的参考图，可以是已知的图片路径（必须是绝对文件系统路径）或URL"),
    }),
    execute: async ({ prompt, images }) => {
        const form = new FormData();
        form.append("prompt", prompt);
        for (const ref of images) {
            const { blob, filename } = await loadImageBlob(ref);
            form.append("images", blob, filename);
        }
        const response = await fetch("http://localhost:3000/generate", {
            method: "POST",
            body: form,
        });
        if (!response.ok) {
            throw new Error(`图像生成失败: ${response.status} ${await response.text()}`);
        }
        const { urls } = await response.json() as { urls: string[] };
        const dir = resolve(".cache", "images");
        await mkdir(dir, { recursive: true });
        const paths: string[] = [];
        for (const url of urls) {
            const blob = await download(url);
            const buffer = Buffer.from(await blob.bytes());
            const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 5);
            const ext = extension(blob.type) || "png";
            const filename = `${hash}.${ext}`;
            await writeFile(resolve(dir, filename), buffer);
            paths.push(`/images/${filename}`);
        }
        return `已生成 ${paths.length} 张图像，路径如下：\n${paths.join("\n")}`;
    }
});

async function runAgent(
    prompt: string, 
    onReply: (chunk: MessagePart) => Promise<void> | void
): Promise<{ fullMessages: ChatCompletionMessageParam[]; usage: any }> {
    const messages = await loadHistory("chat");
    const stickerPrompt = await renderStickers('stickers');
    messages.push({ role: "user", content: prompt });

    const agent = new Agent({
        client,
        model: "deepseek-v4-flash",
        systemPrompt: [systemPrompt.trim(), stickerPrompt.trim()].join("\n\n"),
        messages,
        temperature: 2,
        tools: { ImageGeneration: imageGenerationTool },
        context: null,
        maxSteps: 5,
    });

    const { fullMessages, usage } = await agent.run(async ({ choice }) => {
        console.log("推理内容: ", choice.message.reasoning_content);
        console.log("助手响应: ", choice.message.content);
        
        if (choice.message.content) {
            const parts = await parseMarkdown(choice.message.content);
            for (const part of parts) {
                if (typeof part === 'string') {
                    for (const line of part.split('\n')) {
                        if (!line.trim()) continue;
                        await onReply(line);
                    }
                } else {
                    await onReply(part);
                }
            }
        }
        console.log("对话完成");
    });

    return { fullMessages, usage };
}

const queue: PendingMessage[] = [];
let isWorkerRunning = false;
const mutex = new Mutex();

async function worker() {
    if (isWorkerRunning) return;
    isWorkerRunning = true;

    function collectImageUrls(segments: UnifiedInboundMessage[], urls: Set<string>) {
        for (const seg of segments) {
            if (seg.type === 'image') urls.add(seg.data.url);
            else if (seg.type === 'reply') collectImageUrls(seg.data.segments, urls);
        }
    }

    try {
        while (queue.length > 0) {
            const release = await mutex.acquire();
            try {
                if (queue.length === 0) break;
                
                const batch = queue.splice(0, queue.length);
                const replyCtx = batch[0]!.ctx;
                
                const urls = new Set<string>();
                for (const msg of batch) {
                    collectImageUrls(msg.unifiedMessages, urls);
                }
                
                // 资源处理层
                const imageMap = await processImages(Array.from(urls));
                const prompt = renderBatchToPrompt(batch, imageMap);
                
                console.log(`处理批次 (共 ${batch.length} 条消息):\n${prompt}`);
                
                const { fullMessages, usage } = await runAgent(prompt, async (chunk) => {
                    await replyCtx.reply(chunk);
                    if (typeof chunk === 'string') {
                        await Bun.sleep(500);
                    } else {
                        await Bun.sleep(1000);
                    }
                });
                
                await saveHistory("chat", fullMessages);
                if ((usage?.total_tokens || 0) >= 64000) {
                    await summary(fullMessages);
                }
                
            } catch (error) {
                console.error("Worker 批次处理出错:", error);
            } finally {
                release();
            }
        }
    } finally {
        isWorkerRunning = false;
    }
}

async function main() {
    const bot = new OneBotClient({
        url: 'ws://127.0.0.1:3001/',
        accessToken: 'your_token',
        reconnect: true,
    });

    bot.onMessage(async (event, ctx) => {
        const segments = event.message;
        if (typeof segments === "string") return;

        if (event.message_type === "group") {
            if (event.group_id !== 761178785 && event.group_id !== 976782057) {
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

        const rawText = segments
            .filter(seg => seg.type === "text")
            .map(seg => seg.data.text)
            .join("")
            .trim();

        const isMaster = event.sender.user_id === 2870245624;

        if (rawText === "/ping" && isMaster) {
            const latency = Date.now() - event.time * 1000;
            await ctx.reply(`pong (${latency}ms)`);
            return;
        }

        if (rawText === "/summary" && isMaster) {
            const release = await mutex.acquire();
            try {
                await ctx.reply("正在摘要...");
                const messages = await loadHistory("chat");
                await summary(messages);
                await ctx.reply("摘要完成");
            }
            catch (error) {
                console.error(`主动摘要失败: ${error}`);
                await ctx.reply(`摘要失败: ${error}`);
            }
            finally {
                release();
            }
            return;
        }

        const unified = await convertOneBotToUnified(
            segments,
            async (qq) => {
                if (event.message_type === "group") {
                    const { nickname } = await ctx.client.getGroupMemberInfo(Number(event.group_id), qq);
                    return nickname;
                }
                const { nickname } = await ctx.client.getStrangerInfo(qq);
                return nickname;
            },
            async (id) => {
                const { user_id, message } = await ctx.client.getMessage(Number(id));
                return { userId: user_id, message: message };
            },
        );

        queue.push({
            unifiedMessages: unified,
            nickname: event.sender.nickname,
            date: dayjs(event.time * 1000).format('YYYY-MM-DD dddd HH:mm'),
            ctx,
            isMaster,
        });
        
        worker();
    });

    await bot.connect();
    console.log('已连接');
}

main().catch(console.error);
