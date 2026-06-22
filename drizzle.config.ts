import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration-tmp",
  dbCredentials: {
    // 必须与 src/database/db.ts 中的 DB_PATH 保持一致
    url: resolve(".cache", "db", "app.db"),
  },
});
