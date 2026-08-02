import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { MediaKind, UnifiedInboundMessage } from "@/message/types";

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

// 待处理消息主表
//
// 会话级消息队列的持久化层。`evaluated` 标记是否已被触发判定消费。
// `date` 存 Unix 毫秒时间戳，加载时转回 Date。
// `segments` 用 SQLite 的 TEXT+JSON 模式整体存 `UnifiedInboundMessage[]`，
// 包括 reply 嵌套结构；Drizzle 自动处理序列化，应用层只看到强类型对象。
export const pendingMessages = sqliteTable(
  "pending_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull(),
    nickname: text("nickname").notNull(),
    date: integer("date").notNull(),
    isAt: integer("is_at", { mode: "boolean" }).notNull(),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull(),
    evaluated: integer("evaluated", { mode: "boolean" }),
    segments: text("segments", { mode: "json" }).$type<UnifiedInboundMessage[]>().notNull(),
  },
  (t) => [index("pending_messages_session_idx").on(t.sessionId)],
);

// 媒体转述缓存。虚拟路径由 `/images/`、`/videos/` 前缀区分，文件名由内容哈希生成。
export const mediaCache = sqliteTable(
  "media_cache",
  {
    path: text("path").primaryKey(),
    kind: text("kind", { enum: ["image", "video"] })
      .$type<MediaKind>()
      .notNull(),
    description: text("description").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("media_cache_kind_updated_at_idx").on(t.kind, t.updatedAt)],
);

// 迁移完成后不再由运行时代码使用，保留声明以避免自动迁移误删旧缓存表。
export const legacyImageCache = sqliteTable(
  "image_cache",
  {
    path: text("path").primaryKey(),
    description: text("description").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("image_cache_updated_at_idx").on(t.updatedAt)],
);

export const legacyVideoCache = sqliteTable(
  "video_cache",
  {
    path: text("path").primaryKey(),
    description: text("description").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("video_cache_updated_at_idx").on(t.updatedAt)],
);
