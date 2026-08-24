# WebUI2 开发指南

## 技术栈

- React 19、TypeScript、Vite 8、Tailwind CSS v4。
- 路由使用 `react-router` 的 `HashRouter`，URL 格式为 `/#/path`。
- UI 使用 shadcn/ui 的 Radix Nova 风格，图标使用 `lucide-react`。
- 主题由 `next-themes` 管理，通知由 Sonner 管理。

## 常用命令

在仓库根目录执行：

```bash
pnpm webui2:dev
pnpm webui2:build
pnpm webui2:test
pnpm --filter webui2 lint
```

修改后至少运行 `lint`、`test:run` 和 `build`。格式化指定的改动文件：

```bash
pnpm exec prettier --write <files...>
```

## 目录职责

- `src/App.tsx`：路由定义。
- `src/main.tsx`：应用根节点；保留 `ThemeProvider`、`TooltipProvider`、`HashRouter` 与 `Toaster` 的嵌套。
- `src/layouts/`：应用级布局。
- `src/pages/`：路由页面及其页面级样式。
- `src/components/`：业务或应用级组件。
- `src/components/ui/`：shadcn/ui 组件源码。
- `src/lib/utils.ts`：共享的 `cn()` 工具函数。
- `src/hooks/`：可复用 Hook。
- `src/test/`：Vitest 测试初始化。

使用 `@/` 导入 `src/` 下的模块；不要新增重复的相对路径别名。

## 路由

- 使用 `Link`、`Route`、`Routes` 等 `react-router` API，不使用 `react-router-dom`。
- 保持 `HashRouter`，不要替换为 `BrowserRouter`；这保证静态部署时直接访问子路由不会 404。
- 新增业务页面时，同时在 `App.tsx` 注册路由，并为未知路径保留 `*` 404 路由。
- 仅在页面信息架构确定后添加路由，不创建没有页面实现的占位导航项。

## shadcn/ui 与样式

- 先使用已有的 `src/components/ui/` 组件；只按实际页面需求新增组件。
- 新增组件前先查询 shadcn 官方文档。使用 CLI 时，优先执行 `pnpm dlx shadcn@latest add <component>`。
- 当前根工作区可能导致 shadcn CLI 错误检查旧 `webui` 包。出现该错误时，不要修改旧包或根工作区配置，先报告该限制。
- 不手写替代已有 shadcn/ui 组件的 Button、Dialog、Sidebar、Toast、Skeleton、Empty 等基础组件。
- 使用语义化 Tailwind 令牌，例如 `bg-background`、`text-muted-foreground`、`border-border`，不要使用任意颜色值模拟主题。
- 条件类名使用 `cn()`；不要手写字符串拼接。
- 主题由 `.dark` 类和 `next-themes` 驱动；不要自行读写 `localStorage` 或为浅深色分别堆叠 `dark:` 覆盖规则。
- `Button` 中的图标使用 Lucide 图标，并添加 `data-icon="inline-start"` 或 `data-icon="inline-end"`；不要在其中设置图标尺寸类。
- Tooltip 必须在 `TooltipProvider` 下使用；Dialog、Sheet 必须提供标题以满足无障碍要求。

## 测试

- Vitest 运行于 jsdom，测试文件放在 `src/**/*.test.ts?(x)`。
- 使用 Testing Library 测试用户可见行为，不测试实现细节。
- 涉及响应式布局的测试依赖 `src/test/setup.ts` 提供的 `matchMedia` mock；不要在单个测试内重复定义。
