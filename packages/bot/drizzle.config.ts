import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration-tmp",
  dbCredentials: {
    // 必须与 src/database/db.ts 中的 DB_PATH 保持一致
    url: fileURLToPath(new URL("../../data/db/app.db", import.meta.url)),
  },
});
