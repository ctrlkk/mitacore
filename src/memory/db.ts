import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const sqlite = new Database(resolve('.cache', 'sqlite.db'));
sqlite.run("PRAGMA journal_mode = WAL;");

sqlite.loadExtension('./vec0.dll');

export const db = drizzle({ client: sqlite });