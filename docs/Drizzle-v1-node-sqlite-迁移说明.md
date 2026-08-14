# Drizzle 1.0 与官方 `node:sqlite` 驱动迁移说明

## 背景

当前项目使用 `drizzle-orm@0.45.2` 和 `drizzle-kit@0.31.10`。该版本没有导出
`drizzle-orm/node-sqlite`，所以为 Node 24 运行时临时保留了
`packages/bot/src/database/node-sqlite.ts` 适配层。

Drizzle 1.0 RC 已提供官方 `node:sqlite` 驱动。完成本说明中的迁移后，应删除该临时
适配层，改用官方驱动。

## 为什么不在 Bun 迁移中顺手升级

这不是单纯替换数据库 import：Drizzle Kit 1.0 改变了迁移文件布局。

- 0.x：单个 SQL 文件和 `.drizzle-out/meta/_journal.json`。
- 1.x：每个迁移使用独立目录，不再使用 journal 文件。

项目的 `packages/bot/scripts/migration.ts` 依赖 0.x 布局，将生成的 SQL 转换成
`src/database/migration/*.ts`，并在运行时由自定义的 `__drizzle_migrations` 表记录
迁移。因此必须先迁移这套生成与应用流程，不能只升级依赖。

## 迁移目标

完成后，数据库初始化应使用官方驱动：

```ts
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle({ client: sqlite, schema });
```

随后删除 `packages/bot/src/database/node-sqlite.ts`。

## 推荐执行顺序

1. 新建独立分支，备份真实 SQLite 数据库，并保留当前迁移目录及
   `.drizzle-out` 作为测试样本。
2. 将 `drizzle-orm` 和 `drizzle-kit` 一起升级到同一个明确的 RC 版本。发布时应由
   lockfile 锁定具体版本，避免 `@rc` tag 后续变化造成不可重复构建。
3. 先只验证官方 `drizzle-orm/node-sqlite` 的 CRUD、事务和嵌套事务，再删除临时
   `node-sqlite.ts` 适配层。
4. 重写 `packages/bot/scripts/migration.ts`，使其读取 Kit 1.0 的迁移目录和 SQL 文件，
   而不是读取 `meta/_journal.json` 与目录根下的 `*.sql`。
5. 保持历史 TypeScript 迁移的 `id` 不变。已有用户数据库的
   `__drizzle_migrations` 使用这些 ID；重命名会导致旧迁移被重复执行或遗漏。
6. 决定迁移应用策略：
   - 保留自定义 TypeScript 迁移运行时：为 Kit 1.0 的目录结构生成相同格式的
     `migration/*.ts` 与 `migration.gen.ts`。
   - 改用 Drizzle 官方 migrator：设计一次性兼容步骤，将已有
     `__drizzle_migrations` 记录映射到官方迁移记录，不能直接在已有数据库上切换。
7. 在空数据库和包含历史迁移记录的数据库上分别验证：启动、升级、失败回滚、重复启动
   幂等性，以及生成后的 `migration:check`。
8. 最后运行类型检查、完整构建和 Windows/Linux 发布包冒烟测试。

## 需注意的 v1 破坏性变化

- RQB v1 已移除，关系查询改为 RQB v2 / `defineRelations()`。
- `drizzle({ casing: ... })` 改为表、视图或 schema 级 casing API。
- Drizzle Kit 的迁移格式与迁移记录升级流程有变化。

目前 bot 源码未使用 `relations()`、`db.query` 或 `casing`，因此应用查询层的迁移风险
较低；主要风险集中在自定义迁移生成器。

## 参考

- [Drizzle 官方 Node SQLite 驱动](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite)
- [Drizzle v0 到 v1 变更与升级说明](https://orm.drizzle.team/docs/v0-v1-changes)
- [Node `node:sqlite` 文档](https://nodejs.org/api/sqlite.html)
