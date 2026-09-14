import type { ChatHistory, ChatRecord } from "./chat-history";
import type { PinoLogger } from "@/logger";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getStickersContext } from "@/message/stickers";
import { dataPath } from "@/utils/path";
import dayjs from "shared/time";

export async function injectSystemContext(
  history: ChatHistory,
  prompt: string,
  log: PinoLogger,
): Promise<{ records: ChatRecord[] }> {
  const now = Date.now();
  const userTurn = (history.findLast((record) => record.user_turn !== undefined)?.user_turn ?? 0) + 1;
  const formattedDate = dayjs(now).format("YYYY年M月D日 dddd");
  const stickersContext = await getStickersContext();
  const stickersHash = createHash("sha256").update(stickersContext.content).digest("hex");

  const memoryPath = dataPath("workspace", "notepad", "MEMORY.md");
  const memoryContent = await readFile(memoryPath, "utf8").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      try {
        await mkdir(dirname(memoryPath), { recursive: true });
        await writeFile(memoryPath, "", { encoding: "utf8", flag: "a" });
        return await readFile(memoryPath, "utf8");
      } catch (error) {
        log.error({ err: error }, "创建 MEMORY.md 失败");
        return "";
      }
    }

    log.error({ err: error }, "读取 MEMORY.md 失败");
    return "";
  });

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
  const memoryHash = createHash("sha256").update(memoryContent).digest("hex");
  if (history.findLast((record) => record.system_update?.memory)?.system_update?.memory?.hash !== memoryHash) {
    log.info("长期记忆上下文更新");
    system_update.memory = { hash: memoryHash };
    updates.push(
      "<memory_update>",
      "以下内容替换此前的完整长期记忆。",
      "File: MEMORY.md",
      "",
      "```md",
      memoryContent,
      "```",
      "</memory_update>",
    );
  }

  if (updates.length === 0) {
    return {
      records: [{ message: { role: "user", content: prompt }, timestamp: now, user_turn: userTurn }],
    };
  }

  return {
    records: [
      {
        message: { role: "user", content: `<system_update>\n${updates.join("\n")}\n</system_update>` },
        timestamp: now,
        system_update,
      },
      { message: { role: "user", content: prompt }, timestamp: now, user_turn: userTurn },
    ],
  };
}
