import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { userAlias } from "./schema.sql";

/**
 * 确保 (platform, platformId) 在映射表中，返回行（含自增 id）。
 * 首次见到时插入并打日志；已存在直接返回，不更新 nickname——
 * 这只是个映射缓存，昵称做不到时刻新鲜。
 */
export function ensureUserAlias(platform: string, platformId: string, nickname?: string) {
  const existing = db
    .select()
    .from(userAlias)
    .where(and(eq(userAlias.platform, platform), eq(userAlias.platformId, platformId)))
    .get();
  if (existing) return existing;

  const row = db
    .insert(userAlias)
    .values({ platform, platformId, nickname, createdAt: Date.now() })
    .returning()
    .get();
  console.log(`新用户入缓存：${shortIdFor(row.id)} -> ${platform}/${platformId} (${nickname ?? "未知昵称"})`);
  return row;
}

/** 把 user_alias.id 拼成给 LLM 看的短号（u1、u2…）。 */
export function shortIdFor(id: number) {
  return `u${id}`;
}
