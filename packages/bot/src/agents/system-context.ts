import { getStickersContext } from "@/message/stickers";
import type { ChatHistory, ChatRecord } from "./chat-history";
import type { PinoLogger } from "@/logger";
import dayjs from "@/utils/time";

export async function injectSystemContext(history: ChatHistory, prompt: string, log: PinoLogger) {
  const now = Date.now();
  const formattedDate = dayjs(now).format("YYYY年M月D日 dddd");
  const previousDate = history.findLast((record) => record.system_update?.current_date)?.system_update?.current_date;
  const stickersContext = await getStickersContext();
  const stickersHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stickersContext.content))),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const previousStickers = history.findLast((record) => record.system_update?.stickers)?.system_update?.stickers;
  const dateChanged = previousDate !== formattedDate;
  const stickersChanged = previousStickers?.hash !== stickersHash;

  const updates = [
    dateChanged ? `  <current_date>${formattedDate}</current_date>` : null,
    stickersChanged
      ? [
          "  <stickers_update>",
          "    以下内容替换此前的完整贴纸上下文。",
          ...stickersContext.content.split("\n").map((line) => `    ${line}`),
          "  </stickers_update>",
        ].join("\n")
      : null,
  ].filter((update): update is string => update !== null);

  if (updates.length === 0) {
    return {
      records: [{ message: { role: "user" as const, content: prompt }, timestamp: now }],
    };
  }

  if (dateChanged) {
    log.info(`系统时间更新：${formattedDate}`);
  }
  if (stickersChanged) {
    log.info({ stickerCount: stickersContext.stickers.length }, "贴纸上下文更新");
  }

  const system_update: NonNullable<ChatRecord["system_update"]> = {
    ...(dateChanged ? { current_date: formattedDate } : {}),
    ...(stickersChanged ? { stickers: { hash: stickersHash, snapshot: stickersContext.stickers } } : {}),
  };

  return {
    records: [
      {
        message: { role: "user" as const, content: `<system_update>\n${updates.join("\n")}\n</system_update>` },
        timestamp: now,
        system_update,
      },
      { message: { role: "user" as const, content: prompt }, timestamp: now },
    ],
  };
}
