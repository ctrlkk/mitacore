import { HistoryBusyError } from "./history-access";
import { undoLastConversation } from "./history-management";

export type CommandContext = {
  rawText: string;
  isAdmin: boolean;
  latency: number;
  processing: boolean;
  reply: (message: string) => Promise<unknown>;
};

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
      await context.reply(await undoLastConversation(context.processing));
    } catch (error) {
      await context.reply(
        error instanceof HistoryBusyError ? "当前正在处理消息，暂时无法撤回。" : "撤回失败，请稍后重试。",
      );
    }
    return true;
  }

  return false;
}
