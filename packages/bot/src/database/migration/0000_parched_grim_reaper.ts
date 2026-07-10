import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: "0000_parched_grim_reaper",
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
} satisfies Migration
