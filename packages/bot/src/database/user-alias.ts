import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { userAlias } from "./schema.sql";
import { logger } from "@/logger";

/**
 * 确保 (platform, platformId) 在映射表中，返回行（含自增 id）。
 * 首次见到时插入并打日志；已存在时如果 nickname 不同则更新。
 */
export function ensureUserAlias(platform: string, platformId: string, nickname?: string) {
  const existing = db
    .select()
    .from(userAlias)
    .where(and(eq(userAlias.platform, platform), eq(userAlias.platformId, platformId)))
    .get();

  if (existing) {
    if (nickname && nickname !== existing.nickname) {
      const updated = db.update(userAlias).set({ nickname }).where(eq(userAlias.id, existing.id)).returning().get();
      logger.debug(
        { shortId: shortIdFor(existing.id), oldNickname: existing.nickname ?? "未知昵称", newNickname: nickname },
        "用户昵称更新",
      );
      return updated;
    }
    return existing;
  }

  const row = db.insert(userAlias).values({ platform, platformId, nickname, createdAt: Date.now() }).returning().get();
  logger.debug({ shortId: shortIdFor(row.id), platform, platformId, nickname: nickname ?? "未知昵称" }, "新用户入缓存");
  return row;
}

/** 把 user_alias.id 拼成给 LLM 看的短号（u1、u2…）。 */
export function shortIdFor(id: number) {
  return `u${id}`;
}
