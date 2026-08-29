import type { MediaKind } from "@/message/types";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// 用户 ID 映射表
//
// 平台用户 ID（QQ 号、Lark open_id 等）通常很长，塞进 LLM 上下文里既费 token
// 又难读。这里把每个 (platform, platform_id) 映射到自增 id 上，应用层用
// `u${id}`（u1、u2…）作为 LLM 看到的短号。数据库只存数字，不做拼接。
//
// nickname 是缓存性质的展示名，可空且可能过时；映射本体只看 (platform, platform_id)。
export const userAlias = sqliteTable(
  "user_alias",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull(),
    platformId: text("platform_id").notNull(),
    nickname: text("nickname"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull().default(0),
  },
  (t) => [unique("user_alias_platform_unique").on(t.platform, t.platformId)],
);

// 媒体转述缓存。当前所有媒体统一使用 `/images/` 虚拟路径，文件名由内容哈希生成。
export const mediaCache = sqliteTable(
  "media_cache",
  {
    path: text("path").primaryKey(),
    kind: text("kind", { enum: ["image", "video", "audio"] })
      .$type<MediaKind>()
      .notNull(),
    description: text("description").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("media_cache_kind_updated_at_idx").on(t.kind, t.updatedAt)],
);
