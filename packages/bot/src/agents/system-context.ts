import type { ChatHistory, ChatRecord } from "./chat-history";
import type { PinoLogger } from "@/logger";
import { createHash } from "node:crypto";
import { getStickersContext } from "@/message/stickers";
import dayjs from "@/utils/time";

export async function injectSystemContext(
  history: ChatHistory,
  prompt: string,
  log: PinoLogger,
): Promise<{ records: ChatRecord[] }> {
  const now = Date.now();
  const formattedDate = dayjs(now).format("YYYY年M月D日 dddd");
  const stickersContext = await getStickersContext();
  const stickersHash = createHash("sha256").update(stickersContext.content).digest("hex");

  const system_update: NonNullable<ChatRecord["system_update"]> = {};
  const updates = [];
  if (history.findLast((record) => record.system_update?.current_date)?.system_update?.current_date !== formattedDate) {
    log.info(`系统时间更新：${formattedDate}`);
    system_update.current_date = formattedDate;
    updates.push(`<current_date>当前时间：${formattedDate}</current_date>`);
  }
  if (history.findLast((record) => record.system_update?.stickers)?.system_update?.stickers?.hash !== stickersHash) {
    log.info({ stickerCount: stickersContext.stickers.length }, "贴纸上下文更新");
    system_update.stickers = { hash: stickersHash, snapshot: stickersContext.stickers };
    updates.push(
      "<stickers_update>",
      "以下内容替换此前的完整贴纸上下文。",
      stickersContext.content,
      "</stickers_update>",
    );
  }

  if (updates.length === 0) {
    return {
      records: [{ message: { role: "user", content: prompt }, timestamp: now }],
    };
  }

  return {
    records: [
      {
        message: { role: "user", content: `<system_update>\n${updates.join("\n")}\n</system_update>` },
        timestamp: now,
        system_update,
      },
      { message: { role: "user", content: prompt }, timestamp: now },
    ],
  };
}
