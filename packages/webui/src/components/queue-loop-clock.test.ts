import { describe, expect, it } from "vitest";
import { createLoopClock } from "./queue-loop-clock";

describe("消息循环演示时钟", () => {
  it("大步推进与多次单步推进保持相同的资源、防抖执行顺序", () => {
    function simulate(steps: number[]) {
      const clock = createLoopClock();
      const events: string[] = [];
      clock.setTimeout(() => {
        events.push(`资源:${clock.now()}`);
        clock.setTimeout(() => events.push(`评估:${clock.now()}`), 700);
      }, 1200);
      clock.setTimeout(() => events.push(`静默:${clock.now()}`), 1000);
      for (const step of steps) clock.advance(step);
      return events;
    }
    expect(simulate([2000])).toEqual(["静默:1000", "资源:1200", "评估:1900"]);
    expect(simulate(Array.from({ length: 8 }, () => 250))).toEqual(simulate([2000]));
  });

  it("新消息可取消旧防抖，循环回调可停止自身", () => {
    const clock = createLoopClock();
    const events: number[] = [];
    const oldDebounce = clock.setTimeout(() => events.push(-1), 1000);
    clock.advance(500);
    clock.clearTimeout(oldDebounce);
    clock.setTimeout(() => events.push(clock.now()), 1000);
    const interval = clock.setInterval(() => {
      events.push(clock.now());
      clock.clearInterval(interval);
    }, 100);
    clock.advance(2000);
    expect(events).toEqual([600, 1500]);
  });

  it("重置清除所有任务并归零模拟时间", () => {
    const clock = createLoopClock();
    let called = false;
    clock.setTimeout(() => {
      called = true;
    }, 1000);
    clock.advance(500);
    clock.reset();
    expect(clock.now()).toBe(0);
    clock.advance(2000);
    expect(called).toBe(false);
  });
});
