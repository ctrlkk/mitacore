// esbuild 无法静态分析的运行时 require 链，必须外置后由 bun install 装入 dist
// 共享给 build.ts（esbuild external）和 scripts/build.ts（生成最小 package.json）
export const requirePkgs = [
  "puppeteer-extra-plugin-stealth",
  "puppeteer-extra",
  "clone-deep",
  "lazy-cache",
  "kind-of",
  "is-plain-object",
  "shallow-clone",
  "for-in",
  "for-own",
  "mixin-deep",
] as const;
