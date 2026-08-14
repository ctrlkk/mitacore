import { readFile, writeFile } from "node:fs/promises";
import { migrateHistory } from "@/agents/chat-history";
import { dataPath } from "@/utils/path";

export type CommandContext = {
  rawText: string;
  isAdmin: boolean;
  latency: number;
  processing: boolean;
  reply: (message: string) => Promise<unknown>;
};

async function undoHistory(path: string) {
  let history;
  try {
    history = migrateHistory(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const userMessageIndex = history.findLastIndex((record) => record.user_turn !== undefined);
  if (userMessageIndex < 0) return false;

  await writeFile(path, JSON.stringify(history.slice(0, userMessageIndex), null, 2));
  return true;
}

async function undoLastRound(processing: boolean) {
  if (processing) return "当前正在处理消息，暂时无法撤回。";

  const removedPlannerHistory = await undoHistory(dataPath("planner.json"));
  if (!removedPlannerHistory) return "没有可撤回的上一轮消息。";

  await undoHistory(dataPath("chat.json"));
  return "已撤回上一轮消息。";
}

export async function handleCommand(context: CommandContext): Promise<boolean> {
  if (!context.isAdmin) return false;

  if (context.rawText === "/help") {
    await context.reply(["可用指令：", "/help 查看帮助", "/ping 检查存活", "/undo 撤回上一轮消息"].join("\n"));
    return true;
  }

  if (context.rawText === "/ping") {
    await context.reply(`pong (${context.latency}ms)`);
    return true;
  }

  if (context.rawText === "/undo") {
    try {
      await context.reply(await undoLastRound(context.processing));
    } catch {
      await context.reply("撤回失败，请稍后重试。");
    }
    return true;
  }

  return false;
}
