import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import type { ChatHistory } from "./chat-history";
import { splitHistory } from "./compaction";

function usage(inputTokens: number, outputTokens: number): LanguageModelUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } as LanguageModelUsage;
}

describe("上下文压缩", () => {
  it("固定保留最近 8000 tokens 的历史", () => {
    const history: ChatHistory = [
      { message: { role: "user", content: "第一轮" }, timestamp: 1 },
      { message: { role: "assistant", content: "第一轮回复" }, timestamp: 2, usage: usage(1000, 100) },
      { message: { role: "user", content: "第二轮" }, timestamp: 3 },
      { message: { role: "assistant", content: "第二轮回复" }, timestamp: 4, usage: usage(7000, 500) },
      { message: { role: "user", content: "第三轮" }, timestamp: 5 },
      { message: { role: "assistant", content: "第三轮回复" }, timestamp: 6, usage: usage(9000, 1000) },
    ];

    expect(splitHistory(history).tail).toEqual(history.slice(2));
  });
});
