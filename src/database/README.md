# src/database/

## 来源

Drizzle + TypeScript 迁移模式，从 `E:/works/opencode/packages/core/` 借鉴。

**与 opencode 的关键差异**：opencode 用 drizzle-kit **1.0+**（1.0.0-rc.2），本项目锁在 stable 上限 **0.31.10**。1.0+ 的 `out/baseline/snapshot.json` 增量 diff 机制在 0.31.10 不支持，所以本目录的 out 结构和 diff 流程都做了适配 —— 升级时这段差异是最容易踩坑的地方。

## 模式要点

迁移系统由三块组成：

1. **手写 schema**（`*.sql.ts`）—— 唯一的 schema 真理源，用 drizzle-orm 的 `sqliteTable` 构造函数定义
2. **codegen**（`script/migration.ts`）—— 跑 `drizzle-kit generate` 拿到 SQL，翻译成 TS 模块；同时维护一个"迁移注册表"用动态 import 列出所有迁移
3. **runtime**（`migration.ts`）—— 启动时跑 `apply(db)`，对比 `__drizzle_migrations` journal 表决定 bootstrap 还是增量

为什么是"TS 化"而不是直接 `.sql`：方便 bundler（bun、webpack 等）把迁移作为源码打进产物；也给手写 backfill 逻辑留口子（`up()` 是个普通函数，可以插入任意代码）。

`apply()` 三段式（`migration.ts:14-44`）：

| 数据库状态 | 判定 | 行为 |
|---|---|---|
| 空库 | `sqlite_master` 没有非 `sqlite_` 表 | 跑 `schema.up()` 全量 DDL；建 `__drizzle_migrations` journal 表；把所有已注册迁移标记为已应用 |
| 已有 `__drizzle_migrations` journal 表 | 视为已 bootstrap | 走 `applyOnly()`，对每个未在 journal 的迁移跑 `up()` + 插入 journal |
| 有别的表但没 `__drizzle_migrations` 表 | 拒绝 | 抛"数据库非空且没有 __drizzle_migrations journal 表"——半初始化状态不能盲目迁移 |

codegen 5 步（`script/migration.ts`）：

1. 跑 `drizzle-kit generate` 到持久 out 目录 → drizzle-kit 算 diff，产出新 `<id>.sql` + 更新 `meta/_journal.json` / `meta/<id>_snapshot.json`
2. 把 `<id>.sql` 镜像成 `migration/<id>.ts`（已存在的跳过）
3. 跑 `drizzle-kit generate` 到一次性 throwaway out，产出当前全量 DDL → 写入 `schema.gen.ts`
4. 扫 `migration/*.ts` 重写 `migration.gen.ts` 注册表
5. check 模式：跑同样流程但只比对、不写

## 关键文件地图

### 手写源码
- [`db.ts`](./db.ts) — 连接：开 `bun:sqlite` + WAL，导出带 schema 的 `db` 实例
- [`migration.ts`](./migration.ts) — 运行时 `apply()` / `applyOnly()`
- [`test-tables.sql.ts`](./test-tables.sql.ts) — 测试 schema（user + post），业务替换时改/删这里
- [`../../drizzle.config.ts`](../../drizzle.config.ts) — drizzle-kit 配置
- [`../../script/migration.ts`](../../script/migration.ts) — codegen 入口

### 自动生成（git tracked，不要手改）
- [`schema.gen.ts`](./schema.gen.ts) — 全量 DDL（空库 bootstrap 用）
- [`migration.gen.ts`](./migration.gen.ts) — 迁移注册表（动态 import 列表）
- [`migration/<id>.ts`](./migration/) — 单个迁移的 TS 化 SQL

### 不入库
- `.drizzle-out/` — drizzle-kit 工作目录；journal 在 `meta/_journal.json`，snapshot 在 `meta/<id>_snapshot.json`
- `.cache/db/app.db` — 实际 SQLite 文件

## 升级到 opencode 1.0+ 时看哪里

1. **opencode 实际源码**（权威）：
   - `E:/works/opencode/packages/core/script/migration.ts` — opencode 的 codegen
   - `E:/works/opencode/packages/core/src/database/migration.ts` — opencode 的 runtime
   - `E:/works/opencode/packages/core/drizzle.config.ts` — opencode 的配置
2. **本目录差异点**（要改的地方）：
   - 改回 throwaway out + `out/baseline/snapshot.json` 模式（当前"持久化 out"是 0.31.10 适配）
   - 调整 `generatedMigrations()` / `migrationSql()` 的路径（1.0+ 输出 `<id>/migration.sql` + `<id>/snapshot.json`，0.31.10 输出 `<id>.sql` + `meta/<id>_snapshot.json`）
   - runtime 从原生 async/await 改回 Effect（opencode 用 Effect 全家桶）
3. **依赖升级**：`bun add drizzle-kit@beta drizzle-orm@beta`（两个同步升到同一 beta）
4. **验证**：`bun run migration:check` 应当重新报"No schema changes"；`apply()` 应当跑通所有已 commit 的迁移

## Gotchas

- **持久化 out 目录不能 commit** —— drizzle-kit 的 journal 留着是为了下次能算 diff；commit 进去会和每次 codegen 冲突
- **每个迁移跑在自己一个事务里** —— 不要在迁移里写需要跨事务的逻辑
- **lock 是 in-process 的** —— 跨进程安全靠 SQLite WAL + 文件锁，不靠 `Mutex`
- **空库路径的"标记所有迁移已完成"** —— 因为 `schema.gen.ts` 包含全部当前 DDL，跑了它就等价于跑了所有迁移的合集；这是 bootstrap 优化，不是 bug
- **sentinel 表的选择** —— 我们用 `__drizzle_migrations` journal 表本身做 sentinel（它在 `applyOnly` 一开始就建出来，恒存在；表名沿用 drizzle 官方约定）；opencode 用真实业务表（如 `session`），那是因为 opencode 已有那样的业务表

## 调试去哪看

| 现象 | 看哪里 |
|---|---|
| `apply()` 抛"数据库非空且没有 __drizzle_migrations journal 表" | `migration.ts:31-33` —— 有人手动建过表；删库或补 `__drizzle_migrations` journal |
| codegen 报"schema changes" 但 schema 没改 | `.drizzle-out/meta/_journal.json` 可能损坏；删 `.drizzle-out/` 重跑 |
| 迁移没生效 | `select * from __drizzle_migrations` 看 journal，缺哪条补哪条 |
| 生成的 `.ts` 文件丢了 `import { sql }` | 重新跑 `bun run migration`（codegen 模板会重新生成） |
| 类型错误 | `bunx tsc --noEmit`；`migration.ts:18` 的 `Transaction` 类型如果不对，drizzle-orm 升级时这里会先炸 |
