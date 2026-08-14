#!/usr/bin/env node

// Drizzle TypeScript 迁移 codegen（适配 drizzle-kit 0.31.10）
// 参考 specs/storage/typescript-migrations.md；本项目装的是 0.31.10 而非规范的 1.0+，
// 所以不用 spec 里的 throwaway out + baseline/snapshot.json 约定（0.31.10 不支持），
// 改用持久化 out 目录让 drizzle-kit 的 journal 跨运行保留，自动产出增量迁移。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cwd } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { glob } from "glob";
import { spawn } from "../src/utils/spawn.ts";

const botDir = path.join(import.meta.dirname, "..");
const tsDir = path.join(botDir, "src/database/migration");
const registry = path.join(botDir, "src/database/migration.gen.ts");
const schema = path.join(botDir, "src/database/schema.gen.ts");
const persistentOut = path.join(botDir, "src/database/.drizzle-out");
// tmp 目录放在仓库根（同盘符，且已在 .gitignore）。drizzle-kit 的 out 走 path.relative，
// 跨盘符（如项目在 E:\，os.tmpdir() 在 C:\）算出的"相对路径"是绝对路径，
// drizzle-kit 又会 prepend cwd，导致 ENOENT。
const localTmp = path.join(cwd(), "migration-tmp");
const require = createRequire(import.meta.url);
const drizzleKit = path.join(path.dirname(require.resolve("drizzle-kit")), "bin.cjs");

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    name: { type: "string" },
  },
});

if (args.values.check) {
  await check();
  process.exit(0);
}

await generate();

async function generate() {
  // 当前没有 *.sql.ts / sql.ts 时跳过 drizzle 调用，直接写空 stub。
  if (!(await hasAnySchemaFiles())) {
    await fs.writeFile(schema, renderSchema(""));
    await fs.writeFile(registry, renderRegistry([]));
    return;
  }

  // === Step 1-3: 持久化 out，让 drizzle-kit 的 journal 跨运行保留 ===
  await fs.mkdir(persistentOut, { recursive: true });
  await drizzle(persistentOut, args.values.name);

  // 把所有新生成的 .sql 镜像成 .ts（已存在的跳过，避免覆盖历史）
  const generated = await generatedMigrations(persistentOut);
  for (const name of generated) {
    const target = path.join(tsDir, `${name}.ts`);
    if (await fileExists(target)) continue;
    await fs.writeFile(target, renderMigration(name, await migrationSql(persistentOut, name)));
  }

  // === Step 4: 一次性 throwaway out 跑全量 DDL（schema.gen.ts 给空库 bootstrap 用）===
  await fs.mkdir(localTmp, { recursive: true });
  const fullOut = await fs.mkdtemp(path.join(localTmp, "full-"));
  try {
    await drizzle(fullOut, "schema");
    const fullMigrations = await generatedMigrations(fullOut);
    const fullSql = fullMigrations[0] ? await migrationSql(fullOut, fullMigrations[0]) : "";
    await fs.writeFile(schema, renderSchema(fullSql));
  } finally {
    await fs.rm(fullOut, { recursive: true, force: true });
  }

  // === Step 5: 重新生成迁移注册表 ===
  await fs.writeFile(registry, renderRegistry(await typescriptMigrations()));
}

async function check() {
  if (!(await hasAnySchemaFiles())) {
    if ((await fs.readFile(schema, "utf8")) !== renderSchema("")) {
      throw new Error("数据库 schema 已过期，运行 `node packages/bot/scripts/migration.ts` 重新生成。");
    }
    if ((await fs.readFile(registry, "utf8")) !== renderRegistry([])) {
      throw new Error("迁移注册表已过期，运行 `node packages/bot/scripts/migration.ts` 重新生成。");
    }
    return;
  }

  // check 是纯校验，不应污染持久 out。把 .drizzle-out/meta/ 复制到 temp，drizzle 跑在 temp 上。
  await fs.mkdir(localTmp, { recursive: true });
  const tempOut = await fs.mkdtemp(path.join(localTmp, "check-"));
  try {
    const metaSrc = path.join(persistentOut, "meta");
    if (await dirExists(metaSrc)) {
      await fs.cp(metaSrc, path.join(tempOut, "meta"), { recursive: true });
    }
    await drizzle(tempOut, args.values.name);
    const generated = await generatedMigrations(tempOut);
    const existing = new Set(await typescriptMigrations());
    const missing = generated.filter((name) => !existing.has(name));
    if (missing.length > 0) {
      throw new Error(`有未生成的迁移: ${missing.join(", ")}，运行 \`bun run migration\` 重新生成。`);
    }

    // 校验 schema.gen.ts 和 registry 是否最新（全量 DDL 对比，也在 temp 上跑）
    const fullOut = await fs.mkdtemp(path.join(localTmp, "full-check-"));
    try {
      await drizzle(fullOut, "schema");
      const fullMigrations = await generatedMigrations(fullOut);
      const fullSql = fullMigrations[0] ? await migrationSql(fullOut, fullMigrations[0]) : "";
      if ((await fs.readFile(schema, "utf8")) !== renderSchema(fullSql)) {
        throw new Error("数据库 schema 已过期，运行 `node packages/bot/scripts/migration.ts` 重新生成。");
      }
    } finally {
      await fs.rm(fullOut, { recursive: true, force: true });
    }

    if ((await fs.readFile(registry, "utf8")) !== renderRegistry(await typescriptMigrations())) {
      throw new Error("迁移注册表已过期，运行 `node packages/bot/scripts/migration.ts` 重新生成。");
    }
  } finally {
    await fs.rm(tempOut, { recursive: true, force: true });
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function hasAnySchemaFiles() {
  const cwd = path.join(botDir, "src");
  for (const pattern of ["**/*.sql.ts", "**/sql.ts"]) {
    const matches = await glob(pattern, { cwd });
    if (matches.length > 0) return true;
  }
  return false;
}

async function drizzle(output: string, name?: string) {
  // config 文件扔到 tmpdir，避免污染项目目录；out 用相对路径（drizzle-kit 给绝对路径会重复 prepend cwd 出 bug）
  const config = path.join(
    os.tmpdir(),
    `agents-bot-drizzle-${Date.now()}-${Math.random().toString(36).slice(2)}.config.ts`,
  );
  const relOut = path.relative(botDir, output);
  await fs.writeFile(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(botDir, "drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(relOut)} }
`,
  );
  try {
    const result = await spawn(
      process.execPath,
      [drizzleKit, "generate", "--config", config, ...(name ? ["--name", name] : [])],
      { cwd: botDir },
    );
    if (result.exitCode !== 0) throw new Error(`drizzle-kit 生成失败：${result.stderr}`);
  } finally {
    await fs.rm(config, { force: true });
  }
}

// drizzle-kit 0.31.10 输出结构：<name>.sql + meta/<name>_snapshot.json
async function generatedMigrations(directory: string) {
  return (await glob("*.sql", { cwd: directory })).map((file) => path.basename(file, ".sql")).sort();
}

async function migrationSql(directory: string, name: string) {
  return fs.readFile(path.join(directory, `${name}.sql`), "utf8");
}

async function typescriptMigrations() {
  // 容忍目录不存在（fresh 状态下 check 也要能跑通）
  await fs.mkdir(tsDir, { recursive: true });
  return (await glob("*.ts", { cwd: tsDir })).map((file) => path.basename(file, ".ts")).sort();
}

// 与 src/database/migration.ts 的 `Migration` 类型一致；node:sqlite 的 tx.run 是同步，所以生成代码无 yield*。
function renderMigration(name: string, sql: string) {
  return `import { sql } from "drizzle-orm";
import type { Migration } from "../migration";

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
${renderStatements(sql)}
  },
} satisfies Migration
`;
}

function renderSchema(sql: string) {
  return `import { sql } from "drizzle-orm";
import type { Migration } from "./migration";

export default {
  up(tx) {
${renderStatements(sql)}
  },
} satisfies Omit<Migration, "id">
`;
}

function renderStatements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(renderRun)
    .join("\n");
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n");
  const first = lines[0] ?? "";
  if (lines.length === 1) return `    tx.run(sql\`${escapeTemplate(first)}\`);`;
  return `    tx.run(sql\`\n${lines.map((line) => `      ${escapeTemplate(line)}`).join("\n")}\n    \`);`;
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function renderRegistry(names: string[]) {
  return `import type { Migration } from "./migration";

export const migrations = (
  await Promise.all<{ default: Migration }>([
${names.map((name) => `    import("./migration/${name}"),`).join("\n")}
  ])
).map((module) => module.default) satisfies Migration[]
`;
}
