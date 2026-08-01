/**
 * 极简消息累积调度（拉模型 + debounce）。
 *
 * 收到消息 → push 到 cache → 唤醒主循环
 * 主循环 → 挂起等待 → 静默 1s → 取走整批 → 处理
 */

// ── 类型 ─────────────────────────────────────────────────

interface Message {
  id: string;
  text?: string;
}

// ── 调度器（纯函数 + 闭包，零封装） ─────────────────────

function createMessageScheduler(maxQueue = 30) {
  const cache: Message[] = [];
  let wake: (() => void) | null = null;
  let lastMsgAt = 0;
  let running = false;

  function enqueue(message: Message) {
    while (cache.length >= maxQueue) cache.shift();
    cache.push(message);
    lastMsgAt = Date.now();
    if (wake) {
      wake();
      wake = null; // 已消费，标记为"需要下一轮重新挂起"
    }
  }

  async function run(process: (batch: Message[]) => Promise<void>) {
    running = true;
    while (running) {
      // 挂起等待，零 CPU 占用（处理期间到达的消息已缓存，跳过等待直接处理）
      if (cache.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
      }

      // 等待 1s 静默期，攒批
      while (running && Date.now() - lastMsgAt < 1000) {
        await Bun.sleep(100);
      }
      if (!running) break;

      // 取走当前批次
      const batch = cache.splice(0);
      if (batch.length > 0) await process(batch);
    }
  }

  function stop() {
    running = false;
    wake?.(); // 让主循环退出
  }

  return { enqueue, run, stop };
}

// ── 演示 ─────────────────────────────────────────────────

async function demo(desc: string, fn: (enqueue: (message: Message) => void) => void) {
  console.log(`\n── ${desc}`);
  const scheduler = createMessageScheduler();
  const loop = scheduler.run(async (batch) => {
    const ids = batch.map((m) => m.id).join(", ");
    console.log(`处理 [${ids}] (${batch.length}条)`);
    await Bun.sleep(200); // 模拟 AI 调用
  });

  fn(scheduler.enqueue);
  await Bun.sleep(4000);
  scheduler.stop();
  await loop;
}

async function main() {
  await demo("单条消息立即处理", (enqueue) => {
    enqueue({ id: "A" });
  });

  await demo("连续消息在静默期后合并为一轮", (enqueue) => {
    enqueue({ id: "X" });
    setTimeout(() => enqueue({ id: "Y" }), 200);
    setTimeout(() => enqueue({ id: "Z" }), 400);
  });

  await demo("处理期间到达的消息不会让主循环卡住（竞态修复验证）", (enqueue) => {
    enqueue({ id: "P" });
    // 等第一轮 debounce 结束、开始处理时再发一条（处理耗时 200ms，够宽）
    setTimeout(() => enqueue({ id: "Q" }), 1100);
  });

  await demo("两波消息分开处理（间隔 > 1s）", (enqueue) => {
    enqueue({ id: "1" });
    enqueue({ id: "2" });
    // 等第一轮处理完（~1.2s）后再发第二波
    setTimeout(() => {
      enqueue({ id: "3" });
      enqueue({ id: "4" });
    }, 1300);
  });

  // ── 多会话独立运行 ────────────────────────────────────────

  await demoMultiSession();
}

/**
 * 多会话独立运行演示。
 *
 * 模拟 MaiBot 的 heartflow_manager：每个会话独立维护自己的 bot 实例，
 * 各自独立缓存消息、独立调度、独立处理，互不阻塞。
 */
async function demoMultiSession() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  多会话独立运行（每会话独立 cache + 独立循环）`);
  console.log("=".repeat(50));

  // 会话管理器：按 session_id 路由消息，按需创建 bot（类似 heartflow_manager）
  const sessions = new Map<string, ReturnType<typeof createMessageScheduler>>();
  const loops: Promise<void>[] = [];

  function routeMsg(sessionId: string, msg: Message) {
    if (!sessions.has(sessionId)) {
      const scheduler = createMessageScheduler();
      sessions.set(sessionId, scheduler);
      loops.push(
        scheduler.run(async (batch) => {
          const ids = batch.map((m) => m.id).join(", ");
          console.log(`  [${sessionId}] 处理 [${ids}]`);
          await Bun.sleep(200);
        }),
      );
    }
    sessions.get(sessionId)!.enqueue(msg);
  }

  // 三个会话几乎同时收到消息，各自独立处理
  routeMsg("私聊-小明", { id: "小明-1" });
  routeMsg("群A", { id: "群A-1" });
  routeMsg("私聊-小红", { id: "小红-1" });

  await Bun.sleep(500);

  // 小明继续发，触发自己会话的 debounce，不影响群A和小红
  routeMsg("私聊-小明", { id: "小明-2" });

  await Bun.sleep(3000);

  // 停掉所有会话
  for (const bot of sessions.values()) bot.stop();
  await Promise.all(loops);
}

if (import.meta.main) {
  void main().catch(console.error);
}
