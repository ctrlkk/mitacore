import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: "0003_media_cache",
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
      INSERT INTO \`media_cache\` (\`path\`, \`kind\`, \`description\`, \`created_at\`, \`updated_at\`)
      SELECT \`path\`, 'image', \`description\`, \`created_at\`, \`updated_at\` FROM \`image_cache\`;
    `);
    tx.run(sql`
      INSERT INTO \`media_cache\` (\`path\`, \`kind\`, \`description\`, \`created_at\`, \`updated_at\`)
      SELECT \`path\`, 'video', \`description\`, \`created_at\`, \`updated_at\` FROM \`video_cache\`;
    `);
  },
} satisfies Migration
