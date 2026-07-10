# agents-bot

基于 [Bun](https://bun.com) 的 TypeScript 项目。

## 环境要求

- [Bun](https://bun.com) v1.3.13+

## 安装依赖

```bash
bun install
```

## 命令

### 运行

| 命令 | 说明 |
| --- | --- |
| `bun run dev` | 开发模式运行（`bun run . --watch`，文件变动自动重启） |
| `bun run start` | 直接运行（`bun run .`） |

### 代码格式化

| 命令 | 说明 |
| --- | --- |
| `bun run format` | 用 Prettier 格式化整个项目 |
| `bun run format:check` | 检查代码是否符合 Prettier 格式规范（适合 CI） |

### 数据库迁移

| 命令 | 说明 |
| --- | --- |
| `bun run db` | 在 `packages/bot` 中调用 `drizzle-kit` 官方 CLI（如 `bun run db generate` / `bun run db studio`） |
| `bun run migration` | 执行 `packages/bot/scripts/migration.ts`，根据 `packages/bot/src/**/*.sql.ts` 重新生成 TypeScript 迁移模块、schema 与注册表 |
| `bun run migration:check` | 校验上述生成产物是否最新，过期则报错（适合 CI / 预提交钩子） |
