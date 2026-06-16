import { createCache } from "cache-manager";
import { Keyv } from "keyv";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database as DatabaseSync } from "bun:sqlite";

class KeyvSqliteStore {
  private db: DatabaseSync;
  private initialized = false;
  private tableName: string;

  constructor(db: DatabaseSync, tableName = "keyv_cache") {
    this.db = db;
    this.tableName = tableName;
  }

  clear() {
    this.init();
    this.db.exec(`DELETE FROM ${this.tableName}`);
    return true;
  }

  delete(key: string) {
    this.init();
    const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE key = ?`);
    const result = stmt.run(key);
    return result.changes > 0;
  }

  get(key: string) {
    this.init();
    const now = Date.now();
    const stmt = this.db.prepare(
      `SELECT value FROM ${this.tableName} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
    );
    const result = stmt.get(key, now) as undefined | { value: string };
    if (!result) return undefined;
    return result.value;
  }

  set(key: string, value: string, ttl?: number) {
    this.init();
    const expiresAt = ttl ? Date.now() + ttl : null;
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${this.tableName} (key, value, expires_at) VALUES (?, ?, ?)`);
    stmt.run(key, value, expiresAt);
    return true;
  }

  private init() {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT,
        expires_at INTEGER
      )
    `);
    this.initialized = true;
  }
}

const dir = resolve(".cache", "db");
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const kvDb = new DatabaseSync(join(dir, "cache.db"));
kvDb.exec("PRAGMA journal_mode = WAL");

const kv = new Keyv({
  store: new KeyvSqliteStore(kvDb),
});

const cacheManager = createCache({
  stores: [kv],
});

export const cache = {
  del: cacheManager.del,
  get: cacheManager.get,
  set: cacheManager.set,
};
