import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: "20260819040653_new_dragon_lord",
  up(tx) {
    tx.run(sql`PRAGMA foreign_keys=OFF;`);
    tx.run(sql`
      CREATE TABLE \`__new_user_alias\` (
        \`id\` integer PRIMARY KEY AUTOINCREMENT,
        \`platform\` text NOT NULL,
        \`platform_id\` text NOT NULL,
        \`nickname\` text,
        \`created_at\` integer NOT NULL,
        \`last_seen_at\` integer DEFAULT 0 NOT NULL,
        CONSTRAINT \`user_alias_platform_unique\` UNIQUE(\`platform\`,\`platform_id\`)
      );
    `);
    tx.run(
      sql`INSERT INTO \`__new_user_alias\`(\`id\`, \`platform\`, \`platform_id\`, \`nickname\`, \`created_at\`, \`last_seen_at\`) SELECT \`id\`, \`platform\`, \`platform_id\`, \`nickname\`, \`created_at\`, \`last_seen_at\` FROM \`user_alias\`;`,
    );
    tx.run(sql`DROP TABLE \`user_alias\`;`);
    tx.run(sql`ALTER TABLE \`__new_user_alias\` RENAME TO \`user_alias\`;`);
    tx.run(sql`PRAGMA foreign_keys=ON;`);
    tx.run(sql`DROP INDEX IF EXISTS \`user_alias_platform_unique\`;`);
  },
} satisfies Migration;
