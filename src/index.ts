import { generateText, type LanguageModel, type LanguageModelUsage, type ModelMessage } from 'ai';
import type { OneBotMessageEvent, OneBotMessageSegment } from './onebot/websocket-client';
import { OneBotClient, type OneBotEventContext } from './onebot/onebot-client';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, parse } from 'node:path';
import { createHash } from 'node:crypto';
import { extension, lookup } from 'mime-types';
import { download } from './utils/blob';
import { cache } from './utils/cache';
import { env } from 'node:process';
import { Agent } from './agent2';
import { tool } from './tool';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { imageToText } from './multimedia';
import { parseMarkdown, type MessagePart } from './images';
import { Mutex } from 'async-mutex';
import { z } from 'zod';
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

async function loadHistory(name: string): Promise<ModelMessage[]> {
    try {
        const history = await readFile(resolve('.cache', `${name}.json`), 'utf8');
        return JSON.parse(history);
    } catch { return []; }
}

async function saveHistory(name: string, history: ModelMessage[]) {
    try {
        await mkdir(resolve('.cache'), { recursive: true });
        await writeFile(resolve('.cache', `${name}.json`), JSON.stringify(history, null, 2));
    } catch (error) { console.error(`保存历史记录失败: ${error}`); }
}

const provider = createDeepSeek({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_API_BASE,
});
const model = provider('deepseek-v4-flash');

async function summary(model: LanguageModel, systemPrompt: string, fullMessages: ModelMessage[], tools: Record<string, any>) {
    const { text, usage } = await generateText({
        model,
        system: systemPrompt,
        temperature: 1,
        tools,
        messages: [
            ...fullMessages,
            { role: "user", content: `<system>${summaryPrompt}</system>` },
        ],
    });
    console.log("摘要:", text);
    console.log("usage:", usage);
    await saveHistory("chat", [{ role: "user", content: `<summary>${text}</summary>` }]);
}

const imageGenerationTool = tool({
    description: "根据输入的描述生成图像，当需要视觉内容创作时使用。",
    inputSchema: z.object({
        prompt: z.string().describe("用于生成图像的提示词内容"),
        images: z.array(z.string()).describe("可选的用于图像生成的参考图，必须是绝对文件系统路径").default([]),
    }),
    execute: async ({ prompt, images }) => {
        const form = new FormData();
        form.append("prompt", prompt);
        for (const ref of images) {
            const mime = lookup(ref);
            const mimes = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
            if (!mime || !mimes.has(mime)) {
                return `不支持该类型的图像文件：${ref}`;
            }
            let buffer: Buffer;
            try {
                buffer = await readFile(ref);
            } catch {
                return `图片文件未找到: "${ref}"，可能不存在或已过期，请使用绝对文件系统路径或检查文件是否存在。`;
            }
            const filename = parse(ref).base;
            form.append("images", new Blob([buffer], { type: mime }), filename);
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

async function runAgent(prompt: string, onReply: (chunk: MessagePart) => Promise<void>) {
    const messages = await loadHistory("chat");

    const agent = new Agent({
        model,
        systemPrompt,
        messages,
        tools: { ImageGeneration: imageGenerationTool },
        context: null,
        maxSteps: 5,
        params: {
            temperature: 1,
        },
    });

    const { messages: fullMessages, usage } = await agent.run(prompt, async (result) => {
        if (result.reasoning) {
            console.log("思维链: ", result.reasoning);
        }
        if (result.hasToolCalls) {
            for (const tc of result.toolCalls) {
                console.log("调用工具: ", tc.toolName, JSON.stringify(tc.input));
            }
        }
        console.log("助手响应: ", result.text);

        if (result.text) {
            const parts = await parseMarkdown(result.text);
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
        if (!result.hasToolCalls) {
            console.log("对话完成");
        }
    });

    return { messages: fullMessages, usage };
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
                
                const { messages: fullMessages, usage } = await runAgent(prompt, async (chunk) => {
                    await replyCtx.reply(chunk);
                    if (typeof chunk === 'string') {
                        await Bun.sleep(500);
                    } else {
                        await Bun.sleep(1000);
                    }
                });

                await saveHistory("chat", fullMessages);
                await cache.set("usage", usage);
                if ((usage?.totalTokens || 0) >= 64000) {
                    await summary(model, systemPrompt, fullMessages, { ImageGeneration: imageGenerationTool });
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
                await summary(model, systemPrompt, messages, { ImageGeneration: imageGenerationTool });
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

        if (rawText === "/usage") {
            const u = await cache.get<LanguageModelUsage>("usage");
            const fmt = (v: number | undefined) => (v ?? 0).toLocaleString();
            await ctx.reply([
                `┌ 输入 ${fmt(u?.inputTokens)}`,
                `│  ├ 缓存读 ${fmt(u?.inputTokenDetails?.cacheReadTokens)}`,
                `│  └ 缓存写 ${fmt(u?.inputTokenDetails?.cacheWriteTokens)}`,
                `├ 输出 ${fmt(u?.outputTokens)}`,
                `│  ├ 推理 ${fmt(u?.outputTokenDetails?.reasoningTokens)}`,
                `│  └ 正文 ${fmt(u?.outputTokenDetails?.textTokens)}`,
                `└ 总计 ${fmt(u?.totalTokens)}`,
            ].join('\n'));
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
