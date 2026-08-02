import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "./db";
import { userAlias } from "./schema.sql";
import { logger } from "@/logger";

/**
 * 确保 (platform, platformId) 在映射表中，返回行（含自增 id）。
 * 首次见到时插入并打日志；已存在时刷新最近交互时间，并在 nickname 变化时更新昵称。
 */
export function ensureUserAlias(platform: string, platformId: string, nickname?: string) {
  const now = Date.now();
  const existing = db
    .select()
    .from(userAlias)
    .where(and(eq(userAlias.platform, platform), eq(userAlias.platformId, platformId)))
    .get();

  if (existing) {
    const changes = { lastSeenAt: now, ...(nickname && nickname !== existing.nickname ? { nickname } : {}) };
    const updated = db.update(userAlias).set(changes).where(eq(userAlias.id, existing.id)).returning().get();

    if (nickname && nickname !== existing.nickname) {
      logger.debug(
        { shortId: shortIdFor(existing.id), oldNickname: existing.nickname ?? "未知昵称", newNickname: nickname },
        "用户昵称更新",
      );
    }
    return updated;
  }

  const row = db
    .insert(userAlias)
    .values({ platform, platformId, nickname, createdAt: now, lastSeenAt: now })
    .returning()
    .get();
  logger.debug({ shortId: shortIdFor(row.id), platform, platformId, nickname: nickname ?? "未知昵称" }, "新用户入缓存");
  return row;
}

/** 返回平台上可用于提及的用户，最近交互的用户排在前面。 */
export function listMentionableUserAliases(platform: string) {
  return db
    .select()
    .from(userAlias)
    .where(and(eq(userAlias.platform, platform), isNotNull(userAlias.nickname)))
    .orderBy(desc(userAlias.lastSeenAt), desc(userAlias.id))
    .all();
}

/** 把 user_alias.id 拼成给 LLM 看的短号（u1、u2…）。 */
export function shortIdFor(id: number) {
  return `u${id}`;
}
