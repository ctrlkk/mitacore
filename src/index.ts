import type { ChatCompletionMessageParam } from 'openai/resources';
import { raw, SnowLumaWebSocketClient } from '@snowluma/sdk';
import { marked, type Token, type Tokens } from 'marked';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, parse } from 'node:path';
import { createHash } from 'node:crypto';
import { extension } from 'mime-types';
import { download } from './utils/blob';
import { env } from 'node:process';
import { Agent } from './agent';
import { imageToText } from './multimedia';
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

export async function renderStickers(stickersDir: string): Promise<string> {
    const files = await readdir(stickersDir);
    const pngFiles = files.filter(f => f.endsWith('.png')).sort();
    const stickerList: Record<string, unknown>[] = [];

    for (const pngFile of pngFiles) {
        const baseName = parse(pngFile).name;
        const txtFile = `${baseName}.txt`;
        const txtPath = resolve(stickersDir, txtFile);

        try {
            const description = (await readFile(txtPath, 'utf8')).trim();
            stickerList.push({
                '@_id': pngFile,
                '#text': description,
            });
        } catch { }
    }

    return builder.build({
        stickers: {
            instructions: `你可以在回复中插入贴纸来增强情感表达。贴纸格式为标准的Markdown图片语法：![sticker](id)，id从下方列表中选取（包含扩展名，例如 ![sticker](smile.png)）。
使用原则:
自然融入：贴纸应配合文字情绪，不要强行插入。
先匹配：如果多个关键词都合适，选择最贴切当下情绪的一个。
避免重复：连续多条回复中不要使用同一个关键词。
不滥用：只有当情绪有明显起伏（开心、害羞、疲惫、困惑等）时才使用。平淡的陈述或事实回答中不要加贴纸。
频率控制：贴纸在对话中出现的概率需要控制在20%以下。
使用时只需记住：贴纸是情绪的放大器，不是必填项。 当文字本身已经足够表达时，不加贴纸。`,
            sticker: stickerList
        }
    });
}

// 定义联合类型
type MarkedNode = Token | Tokens.TableCell;

// 类型安全的递归检查函数
function hasImage(node: MarkedNode): boolean {
    // 使用 'type' in node 完美区分 Token 和 TableCell
    if ('type' in node) {
        if (node.type === 'image') return true;
        if (node.type === 'table') {
            return node.header.some(hasImage) || node.rows.some((row: Tokens.TableCell[]) => row.some(hasImage));
        }
        if (node.type === 'list') {
            return node.items.some(hasImage);
        }
        if ('tokens' in node && node.tokens) {
            return node.tokens.some(hasImage);
        }
    } else {
        // 这里是 Tokens.TableCell，它没有 type 属性，但可能有 tokens
        return node.tokens?.some(hasImage) ?? false;
    }
    return false;
}

type MessagePart = string | ReturnType<typeof raw>;

async function parseStickers(content: string): Promise<MessagePart[]> {
    const parts: MessagePart[] = [];
    const tokens = marked.lexer(content);

    let currentText = "";

    const processNodes = async (nodes: MarkedNode[]) => {
        for (const node of nodes) {
            if ('type' in node) {
                if (node.type === 'image') {
                    if (currentText.trim()) {
                        parts.push(currentText.trim());
                        currentText = "";
                    }

                    let stickerId = node.href;
                    const ext = parse(stickerId).ext;
                    if (!ext) {
                        stickerId += '.png';
                    }
                    const stickerPath = resolve('stickers', stickerId);
                    try {
                        const buffer = await readFile(stickerPath);
                        const finalExt = parse(stickerId).ext.slice(1);
                        parts.push(raw("image", {
                            url: `data:image/${finalExt === 'jpg' ? 'jpeg' : finalExt};base64,${buffer.toString('base64')}`,
                            sub_type: 1
                        }));
                    } catch (e) {
                        currentText += node.raw;
                    }
                } else if (hasImage(node)) {
                    // 包含图片，递归处理子节点
                    if (node.type === 'table') {
                        await processNodes(node.header);
                        for (const row of node.rows) {
                            await processNodes(row);
                        }
                    } else if (node.type === 'list') {
                        for (const item of node.items) {
                            await processNodes(item.tokens);
                        }
                    } else if ('tokens' in node && node.tokens) {
                        await processNodes(node.tokens);
                    }

                    // 块级元素补充换行
                    const blockTypes: Token['type'][] = ['paragraph', 'heading', 'blockquote', 'code', 'list', 'table', 'hr'];
                    if (blockTypes.includes(node.type)) {
                        currentText += "\n";
                    }
                } else {
                    // 不包含图片，直接拼接原始 Markdown
                    currentText += node.raw;
                }
            } else {
                if (hasImage(node)) {
                    if (node.tokens) {
                        await processNodes(node.tokens);
                    }
                } else {
                    // TableCell 没有 raw 属性，通过拼接子 Token 的 raw 来保留 Markdown 格式（如加粗、斜体）
                    if (node.tokens) {
                        currentText += node.tokens.map(t => t.raw).join('');
                    } else {
                        currentText += node.text;
                    }
                }
            }
        }
    };

    await processNodes(tokens);

    if (currentText.trim()) {
        parts.push(currentText.trim());
    }

    return parts;
}

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
        console.log(segments);

        const images: { "@_filename": string, "#text": string }[] = [];
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
                images.push({ "@_filename": filename, "#text": description });
                parts.push(`\`${filename}\``);
            }
        }

        let prompt = parts.join("").trim();
        if (!prompt) return;

        prompt = `<user_input>${prompt}</user_input>`
        prompt = [
            builder.build({
                "system_reminder": {
                    "#text": "由于模型不支持图像输入，下面是对话中对应图像的文字描述。\n",
                    "image": images
                }
            }).trim(),
            prompt.trim(),
        ].join("\n\n");

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
                const parts = await parseStickers(choice.message.content);
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
