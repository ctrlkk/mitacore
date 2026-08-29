import { describe, expect, test } from "vitest";
import { resolveMentions, type MentionableUser } from "./mention";

const users: MentionableUser[] = [
  { nickname: "小明", platformId: "10001" },
  { nickname: "小明同学", platformId: "10002" },
  { nickname: "Alice", platformId: "10003" },
];

describe("resolveMentions", () => {
  test("将提及和相邻文本组合为同一条消息链", () => {
    expect(resolveMentions("请问@小明 怎么看？", users)).toEqual([
      { type: "text", data: { text: "请问" } },
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " 怎么看？" } },
    ]);
  });

  test("昵称前缀冲突时优先匹配更长昵称", () => {
    expect(resolveMentions("@小明同学来一下", users)).toEqual([
      { type: "at", data: { qq: "10002" } },
      { type: "text", data: { text: "来一下" } },
    ]);
  });

  test("同名时使用候选列表中最近的用户", () => {
    expect(
      resolveMentions("@小明", [
        { nickname: "小明", platformId: "new" },
        { nickname: "小明", platformId: "old" },
      ]),
    ).toEqual([{ type: "at", data: { qq: "new" } }]);
  });

  test("不把邮箱或英文昵称前缀识别为提及", () => {
    expect(resolveMentions("mail@example.com @AliceBob", users)).toBe("mail@example.com @AliceBob");
  });

  test("无法匹配的昵称保持原文", () => {
    expect(resolveMentions("@陌生人 你好", users)).toBe("@陌生人 你好");
  });
});
