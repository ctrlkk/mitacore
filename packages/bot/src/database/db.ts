import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dataPath } from "@/utils/path";
import { drizzle } from "./node-sqlite";
import * as schema from "./schema.sql";

// 必须与 drizzle.config.ts 中的 dbCredentials.url 保持一致
const DB_PATH = dataPath("db", "app.db");

// node:sqlite 不会自动建父目录，首次启动时手动建一下
mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });
