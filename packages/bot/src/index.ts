export type { UnifiedInboundMessage, MediaKind, MediaMap, PendingMessage } from "@/message/types";
import { logger } from "@/logger";
import { startWebUi } from "@/webui";

if (import.meta.main) {
  const webUiPort = await startWebUi();
  if (typeof process.send === "function") {
    process.send({ type: "ready", port: webUiPort });
  }

  try {
    const { startBot } = await import("@/app/runtime");
    await startBot();
  } catch (error) {
    logger.error({ err: error }, "机器人启动失败，WebUI 将继续运行");
  }

  // 使用定时器避免机器人启动失败后进程退出。
  setInterval(() => {}, 60_000);
}
