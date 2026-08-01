/**
 * 创建一个任务调度器
 * 调度器的设计理念非常简单，通过一个while循环不停的检查消费队列中的消息，调用方不需要关心消息如何被消费，只需要把消息丢进队列等待执行即可。
 * 这种方案既能保证任务的顺序执行，也能扩展支持任务的防抖处理，合并批量执行，节约高成本的调用次数。
 * @param process 任务处理函数，接收一个任务数组并返回一个 Promise
 * @param options 配置项
 * @param options.delay 防抖延迟时间。例如设为 100，则会在收到第一个任务后等待 100ms 再统一处理，期间收集更多任务。
 * @returns 调度器实例
 */
function createScheduler<T>(process: (items: T[]) => Promise<void>, options: { delay?: number } = {}) {
  const { delay = 1000 } = options;

  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let aborted = false;
  let armed = false;

  // 防抖定时器句柄
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function run() {
    while (!aborted) {
      // 未收到 debounce 结束信号时，休眠等待
      if (!armed) {
        await new Promise<void>((r) => {
          wake = r;
        });
      }

      // 检查是否中止
      if (aborted) break;
      if (!armed) continue;

      armed = false;

      // splice(0) 返回原数组所有元素的数组，并将原数组清空
      const items = queue.splice(0, queue.length);

      // 防御性判断（理论上splice后items长度一定>0，但为了保险）
      if (items.length === 0) continue;

      try {
        await process(items);
      } catch (err) {
        console.error("调度器任务处理失败", err);
      }
    }
  }

  function enqueue(item: T) {
    queue.push(item);

    // 防抖逻辑
    if (delay > 0) {
      armed = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        armed = true;
        triggerWake();
      }, delay);
    } else {
      // 无延迟，立即唤醒
      armed = true;
      triggerWake();
    }
  }

  // 辅助函数：唤醒循环
  function triggerWake() {
    if (wake) {
      wake();
      wake = null;
    }
  }

  function abort() {
    aborted = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (wake) {
      wake();
      wake = null;
    }
  }

  const promise = run();
  return { enqueue, abort, wait: () => promise };
}
