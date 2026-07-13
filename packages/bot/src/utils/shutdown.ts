import { logger } from "@/logger";

interface ShutdownTask {
  name: string;
  fn: () => Promise<void> | void;
}

const tasks: ShutdownTask[] = [];
let installed = false;
let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * 注册进程退出时的清理任务。
 *
 * 行为保证：
 * - 防重入：第二次信号（如连按 Ctrl+C）直接 `exit(1)`，不再重复执行清理。
 * - 超时兜底：所有任务超过 10s 未完成则 `exit(1)`，避免清理卡死导致进程僵死。
 * - 异常隔离：单个任务抛错不会阻断后续任务，汇总后按是否有失败决定 exit code。
 * - 顺序执行：按注册顺序串行 await，方便有依赖关系的清理（如先关 WS 再杀进程）。
 */
export function registerShutdownHook(name: string, fn: () => Promise<void> | void): void {
  tasks.push({ name, fn });
  if (installed) return;
  installed = true;
  process.on("SIGINT", (signal) => void runShutdown(signal));
  process.on("SIGTERM", (signal) => void runShutdown(signal));
  process.on("SIGHUP", (signal) => void runShutdown(signal));
}

async function runShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    logger.warn({ signal }, "已在关闭中，强制退出");
    process.exit(1);
    return;
  }
  shuttingDown = true;
  logger.info({ signal, taskCount: tasks.length }, "接收到关闭信号，开始执行清理");

  const forceTimer = setTimeout(() => {
    logger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "清理超时，强制退出进程");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  let failed = false;
  for (const task of tasks) {
    try {
      logger.info({ task: task.name }, "正在清理");
      await task.fn();
      logger.info({ task: task.name }, "清理完成");
    } catch (err) {
      failed = true;
      logger.error({ task: task.name, error: err }, "清理失败");
    }
  }

  clearTimeout(forceTimer);
  logger.info("清理完成，退出进程");
  process.exit(failed ? 1 : 0);
}
