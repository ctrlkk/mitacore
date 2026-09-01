import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";

const { tempDir } = vi.hoisted(() => ({
  tempDir: `${process.env.TEMP ?? "."}/agents-bot-stickers-${crypto.randomUUID()}`,
}));

vi.mock("@/utils/path", () => ({
  dataPath: (...segments: string[]) => [tempDir, ...segments].join("/"),
}));

const { resolveSticker } = await import("./stickers");
const stickersDir = `${tempDir}/workspace/stickers`;

describe("resolveSticker", () => {
  beforeEach(async () => {
    await mkdir(stickersDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("读取本地贴纸并转换为图片消息", async () => {
    await writeFile(`${stickersDir}/开心.png`, new Uint8Array([1, 2, 3, 4]));

    expect(await resolveSticker("开心")).toEqual({
      type: "image",
      raw: "[开心]",
      data: {
        file: "data:image/png;base64,AQIDBA==",
        url: "data:image/png;base64,AQIDBA==",
        sub_type: 1,
        summary: "[开心]",
      },
    });
  });
});
