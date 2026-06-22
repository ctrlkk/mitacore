import { sql } from "drizzle-orm";
import { Mutex } from "async-mutex";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrations } from "./migration.gen";
import schema from "./schema.gen";

// 进程内锁；跨进程安全由 SQLite WAL 保证。
// bun:sqlite 的 db.run / db.all / db.get / db.transaction 都是同步的，所以 apply 内部几乎不需要 await。
const lock = new Mutex();

type AppDatabase = ReturnType<typeof drizzle>;
type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export type Migration = {
  id: string;
  up: (tx: Transaction) => void;
};

// sentinel 选用 `migration` journal 表本身（它在 applyOnly 一开始就建出来）。
// - 表里没有 `migration` 但有别的表 → 拒绝（半初始化状态）
// - 完全是空库 → bootstrap：跑 schema.up + 标记所有迁移已完成
// - 有 `migration` → 走 applyOnly，只跑未完成的迁移
export function apply(db: AppDatabase): Promise<void> {
  return lock.runExclusive(() => {
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    const names = new Set(tables.map((t) => t.name));

    if (names.has("migration")) {
      applyOnly(db, migrations);
      return;
    }
    if (names.size > 0) {
      throw new Error("数据库非空且没有 migration journal 表");
    }

    db.transaction((tx) => {
      schema.up(tx);
      tx.run(
        sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
      );
      for (const migration of migrations) {
        tx.run(
          sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
        );
      }
    });
  });
}

export function applyOnly(db: AppDatabase, input: Migration[]): void {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
  );
  const completed = new Set(
    db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`).map((r) => r.id),
  );
  for (const migration of input) {
    if (completed.has(migration.id)) continue;
    db.transaction((tx) => {
      migration.up(tx);
      tx.run(
        sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
      );
    });
  }
}
