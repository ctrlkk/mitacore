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

  it("句数未超过消息条数上限时每句单独发送", () => {
    expect(splitMessage("啰、啰嗦！那是妾身大方，赏汝的呀……哼。")).toEqual([
      "啰、啰嗦！",
      "那是妾身大方，赏汝的呀……",
      "哼",
    ]);
    expect(splitMessage("你好。再见！", { maxSplitNum: 5 })).toEqual(["你好", "再见！"]);
  });

  it("超过消息条数上限时选择整体长度偏差最小的连续分组", () => {
    // 各句长度为 2、2、4、6、2；局部合并得到 8、6、2，整体最优为 4、4、8。
    expect(splitMessage("嗯！好！知道啦！明天再说吧！行！")).toEqual(["嗯！好！", "知道啦！", "明天再说吧！行！"]);
  });

  it("等长句子均衡分组，不把剩余句子全部放在最后一条", () => {
    expect(splitMessage("第一句。第二句。第三句。第四句。第五句。第六句。")).toEqual([
      "第一句。第二句",
      "第三句。第四句",
      "第五句。第六句",
    ]);
  });

  it("组内跨段落保留一个空格，组首不添加空格", () => {
    const text = "甲！乙！\r\n\r\n丙！丁！";

    expect(splitMessage(text, { maxSplitNum: 1 })).toEqual(["甲！乙！ 丙！丁！"]);
    expect(splitMessage(text, { maxSplitNum: 2 })).toEqual(["甲！乙！", "丙！丁！"]);
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
