export type { UnifiedInboundMessage, MediaKind, MediaMap, ImageMap, PendingMessage } from "@/message/types";
import { logger } from "@/logger";
import { registerShutdownHook } from "@/utils/shutdown";
import { startWebUi } from "@/webui";

if (import.meta.main) {
  const webUi = startWebUi();
  registerShutdownHook("WebUI", () => webUi.stop());

  try {
    const { startBot } = await import("@/app/runtime");
    await startBot();
  } catch (error) {
    logger.error({ err: error }, "机器人启动失败，WebUI 将继续运行");
  }
}
