# agents-bot

基于 Node.js 的 TypeScript 项目。

## 环境要求

- [Node.js](https://nodejs.org/) v24+
- [pnpm](https://pnpm.io/) v11+

## 安装依赖

```bash
pnpm install
```

## 命令

### 运行

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式运行（文件变动自动重启） |
| `pnpm start` | 直接运行 |

### 代码格式化

| 命令 | 说明 |
| --- | --- |
| `pnpm format` | 用 Prettier 格式化整个项目 |
| `pnpm format:check` | 检查代码是否符合 Prettier 格式规范（适合 CI） |

### 数据库迁移

| 命令 | 说明 |
| --- | --- |
| `pnpm db` | 在 `packages/bot` 中调用 `drizzle-kit` 官方 CLI（如 `pnpm db generate` / `pnpm db studio`） |
| `pnpm migration` | 执行 `packages/bot/scripts/migration.ts`，根据 `packages/bot/src/**/*.sql.ts` 重新生成 TypeScript 迁移模块、schema 与注册表 |
| `pnpm migration:check` | 校验上述生成产物是否最新，过期则报错（适合 CI / 预提交钩子） |
