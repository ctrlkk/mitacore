import { describe, expect, it } from "vitest";
import { collectToolParts, messageParts, submitPlanReply, type HistoryRecord } from "./planner-history";

describe("规划层消息预览", () => {
  it("把 submit_plan 工具结果还原为实际回复，并保留换行", () => {
    const output = { type: "text", value: "<reply_result>\n<content>\n第一段\n第二段\n</content>\n</reply_result>" };
    expect(submitPlanReply(output)).toBe("第一段\n第二段");
  });

  it("区分工具调用和返回，避免将未配对结果隐藏", () => {
    const records: HistoryRecord[] = [
      {
        message: {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "submit_plan", input: { plan: "你好" } }],
        },
        timestamp: 1,
      },
      {
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "submit_plan",
              output: { type: "text", value: "回复" },
            },
            {
              type: "tool-result",
              toolCallId: "call-2",
              toolName: "web_search",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
        timestamp: 2,
      },
    ];
    const { calls, results } = collectToolParts(records);
    expect(calls.has("call-1")).toBe(true);
    expect(calls.has("call-2")).toBe(false);
    expect(submitPlanReply(results.get("call-1")?.output)).toBe("回复");
    expect(messageParts(records[1]?.message.content)[1]?.toolName).toBe("web_search");
  });
});
