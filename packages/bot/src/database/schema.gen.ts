import { sql } from "drizzle-orm";
import type { Migration } from "./migration";

export default {
  up(tx) {
    tx.run(sql`
      CREATE TABLE \`media_cache\` (
        \`path\` text PRIMARY KEY NOT NULL,
        \`kind\` text NOT NULL,
        \`description\` text NOT NULL,
        \`created_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL
      );
    `);
    tx.run(sql`CREATE INDEX \`media_cache_kind_updated_at_idx\` ON \`media_cache\` (\`kind\`,\`updated_at\`);`);
    tx.run(sql`
      CREATE TABLE \`user_alias\` (
        \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        \`platform\` text NOT NULL,
        \`platform_id\` text NOT NULL,
        \`nickname\` text,
        \`created_at\` integer NOT NULL,
        \`last_seen_at\` integer DEFAULT 0 NOT NULL
      );
    `);
    tx.run(sql`CREATE UNIQUE INDEX \`user_alias_platform_unique\` ON \`user_alias\` (\`platform\`,\`platform_id\`);`);
  },
} satisfies Omit<Migration, "id">;
