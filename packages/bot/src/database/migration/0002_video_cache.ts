import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: "0002_video_cache",
  up(tx) {
    tx.run(sql`
      CREATE TABLE \`video_cache\` (
        \`path\` text PRIMARY KEY NOT NULL,
        \`description\` text NOT NULL,
        \`created_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL
      );
    `);
    tx.run(sql`CREATE INDEX \`video_cache_updated_at_idx\` ON \`video_cache\` (\`updated_at\`);`);
  },
} satisfies Migration
