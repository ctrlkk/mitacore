// Playwright stealth 插件包含无法静态分析的运行时 require 链，必须保持外置，
// 并由根构建脚本将它们写入 sidecar 的最小运行时依赖。
export const runtimeExternalPackages = [
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
];

export function isRuntimeExternal(id: string) {
  return id.endsWith(".node") || runtimeExternalPackages.some((pkg) => id === pkg || id.startsWith(`${pkg}/`));
}
