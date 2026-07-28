/**
 * 将字节数转换为易读格式
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * 格式化模型 usage 信息（输入、输入缓存、输出、缓存命中率）
 */
export function formatUsage(u: import("ai").LanguageModelUsage | undefined): string {
  if (!u) return "usage: 无数据";
  const input = u.inputTokens ?? 0;
  const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const hitRate = input > 0 ? ((cached / input) * 100).toFixed(1) : "0.0";
  const fmt = (v: number) => v.toLocaleString();
  return `输入=${fmt(input)}  缓存=${fmt(cached)} (命中率 ${hitRate}%)  输出=${fmt(output)}`;
}

/**
 * 打印模型 usage 信息，缓存命中率低于阈值时使用 warn 级别
 */
export function logUsage(log: import("@/logger").PinoLogger, u: import("ai").LanguageModelUsage | undefined) {
  const input = u?.inputTokens ?? 0;
  const cached = u?.inputTokenDetails?.cacheReadTokens ?? 0;
  const hitRate = input > 0 ? (cached / input) * 100 : 0;
  const fn = hitRate < 80 ? log.warn.bind(log) : log.info.bind(log);
  fn(formatUsage(u));
}
