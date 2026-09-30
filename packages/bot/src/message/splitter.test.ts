import { describe, expect, it } from "vitest";
import { cleanMessage, splitMessage } from "./splitter";

describe("cleanMessage", () => {
  it("移除旁白并保留完整标点", () => {
    expect(cleanMessage("（压低声音）今天很好。[短暂停顿]明天也好！")).toBe("今天很好。明天也好！");
  });

  it("内容只有旁白时返回兜底回复", () => {
    expect(cleanMessage("（沉默了一会儿）")).toBe("呃呃");
  });

  it("关闭括号旁白清洗时保留原文和颜文字", () => {
    expect(cleanMessage("（轻声）你好。(≧▽≦)", false)).toBe("（轻声）你好。(≧▽≦)");
    expect(cleanMessage("（沉默了一会儿）", false)).toBe("（沉默了一会儿）");
  });
});

describe("splitMessage", () => {
  it("只为发送分段并移除片段末尾标点", () => {
    const cleanedText = cleanMessage("（轻声）今天很好。明天也好！");

    expect(cleanedText).toBe("今天很好。明天也好！");
    expect(splitMessage(cleanedText, { maxSplitNum: 2 })).toEqual(["今天很好", "明天也好！"]);
  });

  it("不再隐式清理旁白", () => {
    expect(splitMessage("（轻声）你好。")).toEqual(["（轻声）你好"]);
  });

  it("保护颜文字并在分段后恢复", () => {
    const result = splitMessage("好耶！(≧▽≦)明天见。", { maxSplitNum: 2 });

    expect(result.join("")).toContain("(≧▽≦)");
    expect(result.join("")).not.toContain("__KAOMOJI_");
  });

  it("句子数量溢出时返回保留标点的完整文本", () => {
    expect(
      splitMessage("第一句。(≧▽≦)第二句。", {
        maxSentenceNum: 1,
        enableOverflowReturnAll: true,
      }),
    ).toEqual(["第一句。(≧▽≦)第二句。"]);
  });
});
