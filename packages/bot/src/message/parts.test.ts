import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseMarkdown, resolveMessageParts } from "./parts";

const cache = vi.hoisted(() => ({ directory: "" }));

vi.mock("../utils/image-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/image-cache")>()),
  virtualToRealPath: (virtualPath: string) => join(cache.directory, basename(virtualPath)).replaceAll("\\", "/"),
}));

const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x50, 0x45, 0x47, 0xff, 0xd9]);

beforeEach(async () => {
  cache.directory = await mkdtemp(join(tmpdir(), "parts-images-test-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cache.directory, { recursive: true, force: true });
});

describe("图片消息解析", () => {
  test("本地缓存 JPG 直接读取为图片，保留原始引用及文件字节", async () => {
    await writeFile(join(cache.directory, "photo.jpg"), jpegBytes);
    const fetchMock = vi.fn().mockRejectedValue(new Error("本地图片不应调用 fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const markdown = "![照片](/images/photo.jpg)";
    const [part] = await resolveMessageParts(parseMarkdown(markdown));

    expect(part).toMatchObject({ type: "image", raw: markdown });
    if (typeof part !== "object" || part.type !== "image") throw new Error("预期为图片消息");
    expect(part.data.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(part.data.file).toBe(part.data.url);
    expect(Buffer.from(part.data.url.split(",")[1]!, "base64")).toEqual(Buffer.from(jpegBytes));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("缓存文件不存在时保留 Markdown 原文", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("本地图片不应调用 fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const markdown = "![丢失](/images/missing.jpg)";
    expect(await resolveMessageParts(parseMarkdown(markdown))).toEqual([markdown]);
  });

  test("远程 HTTP 图片仍经 fetch 下载并转为图片消息", async () => {
    const url = "https://example.com/photo.jpg";
    const fetchMock = vi.fn().mockResolvedValue(new Response(jpegBytes, { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    const markdown = `![远程照片](${url})`;
    const [part] = await resolveMessageParts(parseMarkdown(markdown));

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url);
    expect(part).toMatchObject({ type: "image", raw: markdown });
    if (typeof part !== "object" || part.type !== "image") throw new Error("预期为图片消息");
    expect(part.data.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(part.data.file).toBe(part.data.url);
    expect(Buffer.from(part.data.url.split(",")[1]!, "base64")).toEqual(Buffer.from(jpegBytes));
  });
});
