import { sql } from "drizzle-orm";
import type { Migration } from "./migration";

export default {
  up(tx) {},
} satisfies Omit<Migration, "id">;
