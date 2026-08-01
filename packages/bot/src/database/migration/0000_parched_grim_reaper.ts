import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  // 已部署数据库使用的是这个历史 ID；文件名需与 Drizzle 的 SQL 历史保持一致。
  id: "0000_add_user_alias",
  up(tx) {
    tx.run(sql`
      CREATE TABLE \`user_alias\` (
        \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        \`platform\` text NOT NULL,
        \`platform_id\` text NOT NULL,
        \`nickname\` text,
        \`created_at\` integer NOT NULL
      );
    `);
    tx.run(sql`CREATE UNIQUE INDEX \`user_alias_platform_unique\` ON \`user_alias\` (\`platform\`,\`platform_id\`);`);
  },
} satisfies Migration;
