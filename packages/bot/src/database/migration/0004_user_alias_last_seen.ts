import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: "0004_user_alias_last_seen",
  up(tx) {
    tx.run(sql`ALTER TABLE \`user_alias\` ADD \`last_seen_at\` integer DEFAULT 0 NOT NULL;`);
  },
} satisfies Migration;
