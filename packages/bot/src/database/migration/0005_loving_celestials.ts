import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: "0005_loving_celestials",
  up(tx) {
    tx.run(sql`DROP TABLE \`image_cache\`;`);
    tx.run(sql`DROP TABLE \`video_cache\`;`);
    tx.run(sql`DROP TABLE \`pending_messages\`;`);
  },
} satisfies Migration;
