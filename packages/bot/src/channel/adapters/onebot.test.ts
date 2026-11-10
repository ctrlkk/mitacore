import { describe, expect, test } from "vitest";
import type { ImagePart } from "@/message/parts";
import { toOneBotMessage } from "./onebot";

describe("toOneBotMessage", () => {
  test("将 MP3 Blob 转换为字节一致的 base64 record", async () => {
    const bytes = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0xff]);
    const result = await toOneBotMessage({ type: "audio", blob: new Blob([bytes], { type: "audio/mpeg" }) });

    expect(result).toEqual({
      type: "record",
      data: { file: `base64://${Buffer.from(bytes).toString("base64")}` },
    });
    if (typeof result === "string" || Array.isArray(result) || !("type" in result) || result.type !== "record") {
      throw new Error("预期转换结果为 record 消息段");
    }
    expect(Buffer.from(result.data.file!.slice("base64://".length), "base64")).toEqual(Buffer.from(bytes));
  });

  test("拒绝空音频 Blob", async () => {
    await expect(toOneBotMessage({ type: "audio", blob: new Blob([], { type: "audio/mpeg" }) })).rejects.toThrow(
      "音频 Blob 不能为空",
    );
  });

  test("拒绝非音频 MIME", async () => {
    await expect(
      toOneBotMessage({ type: "audio", blob: new Blob(["not audio"], { type: "text/plain" }) }),
    ).rejects.toThrow("音频 Blob 的 MIME 类型必须为 audio/*");
  });

  test("保持文本提及映射行为", async () => {
    await expect(toOneBotMessage("你好 @小明", [{ nickname: "小明", platformId: "10001" }])).resolves.toEqual([
      { type: "text", data: { text: "你好 " } },
      { type: "at", data: { qq: "10001" } },
    ]);
  });

  test("保持图片消息映射行为", async () => {
    const image: ImagePart = {
      type: "image",
      raw: "![示例](image.png)",
      data: { file: "base64://aW1hZ2U=", url: "data:image/png;base64,aW1hZ2U=" },
    };

    await expect(toOneBotMessage(image)).resolves.toBe(image);
  });
});
