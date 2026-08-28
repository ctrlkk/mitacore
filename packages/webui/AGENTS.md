只在用户要求的时候主动使用playwright去验收前端效果。
在编写这里的前端代码时，移动设备也在考虑范围内。

## Tailwind CSS

- 项目使用 Tailwind CSS v4，优先使用已有的 canonical utility，不要为标准间距、尺寸或圆角编写不必要的任意值。例如使用 `min-h-90`、`min-w-24`、`w-0.5`、`rounded-xs`，不要使用等价的 `min-h-[360px]`、`min-w-[96px]`、`w-[2px]`、`rounded-[2px]`。
- 只有在没有等价设计 token，或样式依赖 viewport、CSS 变量、运行时尺寸、`calc()`、`minmax()`、`color-mix()` 等计算时，才使用任意值。不要为了消除编辑器提示而改变这些样式的语义。
- CSS 变量使用 Tailwind v4 语法，例如 `w-(--sidebar-width)`，不要把变量值硬编码为固定尺寸。
- 不要动态拼接 Tailwind class，例如 `w-${width}`。使用包含完整 class 字符串的静态映射，并通过 `cn()` 合并 class。