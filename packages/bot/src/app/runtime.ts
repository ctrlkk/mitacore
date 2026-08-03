import { createBot } from "@/app/queue-loop";
import { config } from "@/config";
import { startOneBotChannel } from "@/channel/adapters/onebot";
import { startWeixinChannel } from "@/channel/adapters/weixin";

export async function startBot() {
  // 先跑数据库迁移：空库走 bootstrap，已 bootstrap 的库只跑新增迁移
  const { db } = await import("@/database/db");
  const { apply } = await import("@/database/migration");
  await apply(db);

  const botMap = new Map<string, ReturnType<typeof createBot>>();
  const getBot = (sessionId: string) => {
    let bot = botMap.get(sessionId);
    if (!bot) {
      bot = createBot(sessionId);
      botMap.set(sessionId, bot);
    }
    return bot;
  };

  await Promise.all([
    (async () => {
      if (config.napcat.enabled) await startOneBotChannel(getBot);
    })(),
    (async () => {
      if (config.weixin.enabled) await startWeixinChannel(getBot);
    })(),
  ]);
}
