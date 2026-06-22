import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema.sql";

// 必须与 drizzle.config.ts 中的 dbCredentials.url 保持一致
const DB_PATH = resolve(".cache", "db", "app.db");

// bun:sqlite 不会自动建父目录，首次启动时手动建一下
mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.run("PRAGMA journal_mode = WAL;");

export const db = drizzle({ client: sqlite, schema });
