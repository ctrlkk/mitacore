import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistoryPage } from "./ConversationHistoryPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("对话历史页", () => {
  it("以 planner 消息为主体，在 submit_plan 调用中展示回复结果", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          version: "v1",
          planner: [
            { message: { role: "user", content: "你好" }, timestamp: 100, user_turn: 1 },
            {
              message: {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "call-1", toolName: "submit_plan", input: { plan: "问候用户" } },
                ],
              },
              timestamp: 110,
            },
            {
              message: {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "submit_plan",
                    output: {
                      type: "text",
                      value: "<reply_result>\n<content>\n你好，很高兴见到你\n</content>\n</reply_result>",
                    },
                  },
                ],
              },
              timestamp: 120,
            },
          ],
          reply: [{ message: { role: "assistant", content: "回复层原始内容" }, timestamp: 120 }],
          rounds: [
            {
              start: 0,
              end: 3,
              user_index: 0,
              user_turn: 1,
              timestamp: 100,
              preview: "你好",
              reply_start: 0,
              can_rollback: true,
            },
          ],
        }),
      ),
    );

    render(<ConversationHistoryPage />);

    expect(await screen.findByText("你好，很高兴见到你")).toBeInTheDocument();
    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.getByText("submit_plan")).toBeInTheDocument();
    expect(screen.queryByText("回复层原始内容")).not.toBeInTheDocument();
    expect(screen.queryByText("对话轮次")).not.toBeInTheDocument();
  });

  it("普通工具的调用参数和结果都在消息列表中可见", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          version: "v1",
          planner: [
            {
              message: {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "search-1", toolName: "web_search", input: { query: "星星" } },
                  { type: "tool-call", toolCallId: "task-1", toolName: "task", input: { task: "查询" } },
                ],
              },
              timestamp: 100,
            },
            {
              message: {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "search-1",
                    toolName: "web_search",
                    output: { type: "text", value: "找到网页" },
                  },
                  {
                    type: "tool-result",
                    toolCallId: "task-1",
                    toolName: "task",
                    output: { type: "text", value: "任务完成" },
                  },
                ],
              },
              timestamp: 110,
            },
          ],
          reply: [],
          rounds: [],
        }),
      ),
    );

    render(<ConversationHistoryPage />);

    expect(await screen.findByText("找到网页")).toBeVisible();
    expect(screen.getByText("任务完成")).toBeVisible();
    expect(screen.getAllByText("工具调用")).toHaveLength(2);
    expect(screen.getAllByText("工具结果")).toHaveLength(2);
    expect(screen.getByText(/星星/)).toBeVisible();
    expect(screen.getByText(/查询/)).toBeVisible();
  });

  it("从列表里的用户消息发起双层回退", async () => {
    const fetchMock = vi.fn((_url: string, options?: RequestInit) =>
      Promise.resolve(
        Response.json(
          options?.method === "POST"
            ? { removed_planner: 1, removed_reply: 0 }
            : {
                version: "v1",
                planner: [
                  { message: { role: "user", content: "第一条" }, timestamp: 100, user_turn: 1 },
                  { message: { role: "assistant", content: "规划内容" }, timestamp: 110 },
                  { message: { role: "user", content: "第二条" }, timestamp: 200, user_turn: 2 },
                ],
                reply: [],
                rounds: [
                  { start: 0, user_index: 0, reply_start: null, can_rollback: true },
                  { start: 2, user_index: 2, reply_start: null, can_rollback: true },
                ],
              },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ConversationHistoryPage />);

    expect(await screen.findByText("第二条")).toBeInTheDocument();
    expect(screen.getByText("第一条")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "从此处回退" })[1]!);
    expect(screen.getByText("从这条消息起回退历史？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/conversation-history/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_index: 2, version: "v1" }),
      });
    });
  });
});
