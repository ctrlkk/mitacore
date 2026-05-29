import type { ChatCompletionMessageParam } from 'openai/resources';
import { image, SnowLumaWebSocketClient } from '@snowluma/sdk';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, parse } from 'node:path';
import { env } from 'node:process';
import { Agent } from './agent';
import OpenAI from 'openai';
import XMLBuilder from 'fast-xml-builder';

import systemPrompt from "../prompts/贤惠幼妻仙狐小姐.md";
import summaryPrompt from "../prompts/summary.md";
import { sleep } from 'bun';

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
            instructions: '你可以在回复中插入贴纸来增强情感表达。贴纸格式为 [sticker:id]，id从下方列表中选取。',
            sticker: stickerList
        }
    });
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
        const messageContent = event.raw_message;
        if (!messageContent) return;
        if (event.user_id !== 2870245624) return;
        console.log(`收到消息: ${messageContent}`);

        const messages = await loadHistory("chat");

        if (messages.length <= 0) {
            messages.push({
                role: "user",
                name: "developer",
                content: await renderStickers('stickers'),
            })
        }

        messages.push({ role: "user", content: messageContent });
        
        const agent = new Agent({
            client,
            model: "deepseek-v4-flash",
            systemPrompt,
            temperature: 1.2,
            messages,
            tools: {},
            context: null,
            maxSteps: 5,
        });

        console.log('开始处理');
        const { fullMessages, usage } = await agent.run(async ({ choice }) => {
            console.log(choice.message.content);
            if (choice.message.content) {
                const parts = await parseStickers(choice.message.content);
                for (const part of parts) {
                    await ctx.reply(part);
                    await sleep(1000);
                }
            }
        });
        console.log('处理完成');

        await saveHistory("chat", fullMessages);
        if ((usage?.total_tokens || 0) < 64000) {
            return;
        }
        await summary(fullMessages);
    });

    await bot.connect();
    console.log('已连接');

    async function parseStickers(content: string): Promise<(string | ReturnType<typeof image>)[]> {
        const parts: (string | ReturnType<typeof image>)[] = [];
        const regex = /\[sticker:([^\]]+)\]/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(content)) !== null) {
            const text = content.slice(lastIndex, match.index).trim();
            if (text) parts.push(text);

            let stickerId = match[1]!;
            const ext = parse(stickerId).ext;
            if (!ext) {
                stickerId += '.png';
            }

            const stickerPath = resolve('stickers', stickerId);
            const buffer = await readFile(stickerPath);
            const finalExt = parse(stickerId).ext.slice(1);
            parts.push(image(`data:image/${finalExt === 'jpg' ? 'jpeg' : finalExt};base64,${buffer.toString('base64')}`));

            lastIndex = regex.lastIndex;
        }

        const remaining = content.slice(lastIndex).trim();
        if (remaining) parts.push(remaining);

        return parts;
    }
}

main().catch(console.error);
