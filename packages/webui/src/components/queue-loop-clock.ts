// 所有演示任务共用虚拟时间，暂停与倍速不会改变防抖、资源等待之间的先后关系。
export function createLoopClock() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; callback: () => void; interval?: number }>();

  function schedule(callback: () => void, delay: number, interval?: number) {
    const id = ++nextId;
    tasks.set(id, { at: now + delay, callback, interval });
    return id;
  }

  function clear(id: number | undefined) {
    if (id !== undefined) tasks.delete(id);
  }

  return {
    now: () => now,
    setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
    setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
    clearTimeout: clear,
    clearInterval: clear,
    clear: () => tasks.clear(),
    reset() {
      tasks.clear();
      now = 0;
    },
    advance(delta: number) {
      const end = now + delta;
      // 按到期时间执行；回调新建的任务也参与本次推进，保证倍速下的顺序一致。
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, task] = next;
        now = task.at;
        if (task.interval) task.at += task.interval;
        else tasks.delete(id);
        task.callback();
      }
      now = end;
    },
  };
}
