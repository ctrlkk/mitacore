import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { downloadToCache } from "./blob";

const temporaryDirectories: string[] = [];
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function createCacheDir(): Promise<string> {
  const cacheDir = await mkdtemp(join(tmpdir(), "blob-cache-test-"));
  temporaryDirectories.push(cacheDir);
  return cacheDir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("downloadToCache", () => {
  test("传递请求头与信号，并将图片字节写入缓存", async () => {
    const cacheDir = await createCacheDir();
    const headers = { Authorization: "Bearer test-token" };
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(new Response(pngBytes, { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadToCache("https://example.com/image", { cacheDir, headers, signal });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://example.com/image", { headers, signal });
    expect(result.fileName).toMatch(/\.png$/);
    expect(result.realPath).toBe(join(cacheDir, result.fileName));
    expect(await readFile(result.realPath)).toEqual(Buffer.from(pngBytes));
    expect(await readdir(cacheDir)).toEqual([result.fileName]);
  });

  test("流传输过程中取消会拒绝并清除临时文件", async () => {
    const cacheDir = await createCacheDir();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(pngBytes);
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

    const downloadPromise = downloadToCache("https://example.com/image", { cacheDir, signal: controller.signal });
    try {
      await vi.waitFor(async () => {
        const files = await readdir(cacheDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/\.tmp$/);
        expect(await readFile(join(cacheDir, files[0]!))).toEqual(Buffer.from(pngBytes));
      });
    } finally {
      controller.abort();
    }

    await expect(downloadPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test("超过大小限制会拒绝并清除临时文件", async () => {
    const cacheDir = await createCacheDir();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(pngBytes.subarray(0, 8));
        stream.enqueue(pngBytes.subarray(8));
        stream.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

    await expect(downloadToCache("https://example.com/image", { cacheDir, limit: 8 })).rejects.toThrow(
      "下载大小超过限制",
    );
    expect(await readdir(cacheDir)).toEqual([]);
  });
});
