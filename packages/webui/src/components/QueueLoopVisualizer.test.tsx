import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueLoopVisualizer } from "./QueueLoopVisualizer";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  ReactFlow: () => null,
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("消息循环实验台", () => {
  it("为并行预处理消息分配不同耗时", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    render(<QueueLoopVisualizer maxQueue={10} debounceMs={1000} />);

    click("普通消息");
    click("普通消息");
    expect(screen.getByLabelText("异步预处理消息数")).toHaveTextContent("2");

    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByLabelText("异步预处理消息数")).toHaveTextContent("1");
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByLabelText("异步预处理消息数")).toHaveTextContent("0");
  });

  it("暂停冻结防抖与资源任务，单步只推进模拟时间，重置取消旧任务", () => {
    render(<QueueLoopVisualizer maxQueue={10} debounceMs={1000} />);
    click("@ / 私聊消息");
    click("暂停");
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1000");
    expect(screen.getByLabelText("异步预处理消息数")).toHaveTextContent("1");
    click("单步");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "750");
    click("播放速度 1 倍，点击切换");
    click("继续");
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    click("重置");
    act(() => vi.advanceTimersByTime(5000));
    expect(within(screen.getByRole("region", { name: "会话队列" })).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByLabelText("异步预处理消息数")).toHaveTextContent("0");
  });

  it("普通消息评估后保留，硬触发取走整批，处理中继续接收新消息", () => {
    render(<QueueLoopVisualizer maxQueue={10} debounceMs={1000} />);
    for (let index = 0; index < 5; index++) click("普通消息");
    act(() => vi.advanceTimersByTime(4000));
    const queue = screen.getByRole("region", { name: "会话队列" });
    expect(within(queue).getAllByRole("listitem")).toHaveLength(5);
    click("@ / 私聊消息");
    act(() => vi.advanceTimersByTime(4000));
    expect(within(queue).queryAllByRole("listitem")).toHaveLength(0);
    click("普通消息");
    expect(within(queue).getAllByRole("listitem")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1500));
    expect(within(queue).getAllByRole("listitem")).toHaveLength(1);
  });
});
