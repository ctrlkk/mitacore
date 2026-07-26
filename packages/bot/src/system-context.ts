import type { ChatHistory } from "@/types/chat-history";
import type { PinoLogger } from "@/logger";
import dayjs from "@/utils/time";

export function injectSystemContext(history: ChatHistory, prompt: string, log: PinoLogger) {
  const lastUserRecord = history.findLast((r) => r.message.role === "user");
  const now = Date.now();
  if (!lastUserRecord || !dayjs(lastUserRecord.timestamp).isSame(now, "day")) {
    const formattedDate = dayjs(now).format("YYYY年M月D日 dddd");
    const contextContent = `<system_update>\n当前日期：${formattedDate}\n</system_update>`;
    log.info(`系统时间更新：${formattedDate}`);
    return contextContent + "\n\n" + prompt;
  }
  return prompt;
}
