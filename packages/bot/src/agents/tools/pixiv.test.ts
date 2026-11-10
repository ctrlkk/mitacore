import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinoLogger } from "@/logger";

const mocks = vi.hoisted(() => ({
  config: { pixiv: { phpsessid: "test-session" } },
  downloadToCache: vi.fn(),
}));

vi.mock("@/config", () => ({ config: mocks.config }));
vi.mock("@/utils/image-cache", () => ({ downloadToCache: mocks.downloadToCache }));

import { pixivDownload, pixivSearch } from "./pixiv";

const context = { toolCallId: "test", messages: [], context: {} };
const log = { error: vi.fn() } as unknown as PinoLogger;
const fetchMock = vi.fn<typeof fetch>();

function apiResponse(body: unknown, error = false, message?: string): Response {
  return new Response(JSON.stringify({ error, message, body }), {
    headers: { "Content-Type": "application/json" },
  });
}

function artwork(illustType = 0) {
  return {
    id: "123",
    title: "测试作品",
    userId: "42",
    userName: "画师",
    illustType,
    xRestrict: 0,
    pageCount: 2,
    tags: { tags: [{ tag: "猫" }, { tag: "风景" }] },
  };
}

const pages = [0, 1].map((index) => ({
  urls: {
    original: `https://i.pximg.net/img-original/img/123_p${index}.png`,
    regular: `https://i.pximg.net/img-master/img/123_p${index}_master1200.jpg`,
  },
  width: 800 + index,
  height: 600 + index,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.pixiv.phpsessid = "test-session";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("pixivSearch", () => {
  it("编码关键词并传递搜索页码与分级，过滤不可见作品后应用 limit", async () => {
    const query = "猫 耳/青";
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        illustManga: {
          total: 35,
          data: [
            { id: "1", title: "隐藏", isMasked: true },
            { id: "2", title: "可见", userId: "42", userName: "画师", tags: ["猫"], pageCount: 2 },
            { id: "3", isMasked: false },
            { id: "4", title: "另一张" },
          ],
        },
      }),
    );

    const result = await pixivSearch(log).execute!({ query, page: 3, limit: 1, mode: "safe" }, context);

    expect(result).toEqual({
      query,
      page: 3,
      total: 35,
      results: [
        {
          illust_id: "2",
          title: "可见",
          author_id: "42",
          author: "画师",
          tags: ["猫"],
          illust_type: undefined,
          x_restrict: undefined,
          page_count: 2,
          url: "https://www.pixiv.net/artworks/2",
        },
      ],
    });
    const [url, options] = fetchMock.mock.calls[0]!;
    const requestUrl = new URL(String(url));
    expect(requestUrl.origin).toBe("https://www.pixiv.net");
    expect(requestUrl.pathname).toBe(`/ajax/search/artworks/${encodeURIComponent(query)}`);
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      word: query,
      p: "3",
      mode: "safe",
      s_mode: "s_tag",
      type: "all",
    });
    expect(options).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: "PHPSESSID=test-session" }),
        redirect: "error",
      }),
    );
    expect(mocks.downloadToCache).not.toHaveBeenCalled();
  });

  it("API 报错时返回可读错误", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(null, true, "登录已过期"));

    expect(await pixivSearch(log).execute!({ query: "猫" }, context)).toEqual({
      error: "Pixiv 搜索失败：登录已过期",
    });
  });

  it("未配置 PHPSESSID 时匿名搜索，不发送 Cookie 请求头", async () => {
    mocks.config.pixiv.phpsessid = "";
    fetchMock.mockResolvedValueOnce(
      apiResponse({ illustManga: { total: 1, data: [{ id: "123", title: "公开作品" }] } }),
    );

    expect(await pixivSearch(log).execute!({ query: "猫" }, context)).toMatchObject({
      total: 1,
      results: [{ illust_id: "123", title: "公开作品" }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has("Cookie")).toBe(false);
  });

  it("预先取消的请求不访问 API", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await pixivSearch(log).execute!({ query: "猫" }, { ...context, abortSignal: controller.signal })).toEqual({
      error: "Pixiv 搜索失败：请求超时或已取消",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pixivDownload", () => {
  it("未配置 PHPSESSID 时匿名获取作品并下载公开图片", async () => {
    mocks.config.pixiv.phpsessid = "";
    fetchMock.mockResolvedValueOnce(apiResponse(artwork())).mockResolvedValueOnce(apiResponse(pages));
    mocks.downloadToCache.mockResolvedValueOnce({ virtualPath: "/images/public.png" });

    expect(await pixivDownload(log).execute!({ illust_id: "123" }, context)).toMatchObject({
      illust_id: "123",
      images: [{ page_index: 0, path: "/images/public.png" }],
      errors: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(new Headers(options?.headers).has("Cookie")).toBe(false);
    }
    expect(mocks.downloadToCache).toHaveBeenCalledOnce();
    const imageHeaders = new Headers(mocks.downloadToCache.mock.calls[0]![1].headers);
    expect(imageHeaders.has("Cookie")).toBe(false);
    expect(imageHeaders.get("Referer")).toBe("https://www.pixiv.net/");
  });

  it("按 0 基页码下载多页原图，图片请求只带 Referer 不带 Cookie", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(artwork())).mockResolvedValueOnce(apiResponse(pages));
    mocks.downloadToCache
      .mockResolvedValueOnce({ virtualPath: "/images/first.png" })
      .mockResolvedValueOnce({ virtualPath: "/images/second.png" });

    const result = await pixivDownload(log).execute!({ illust_id: "123", page_indexes: [1, 0] }, context);

    expect(result).toEqual({
      illust_id: "123",
      title: "测试作品",
      author_id: "42",
      author: "画师",
      tags: ["猫", "风景"],
      page_count: 2,
      x_restrict: 0,
      url: "https://www.pixiv.net/artworks/123",
      images: [
        { page_index: 1, path: "/images/first.png", width: 801, height: 601 },
        { page_index: 0, path: "/images/second.png", width: 800, height: 600 },
      ],
      errors: [],
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://www.pixiv.net/ajax/illust/123",
      "https://www.pixiv.net/ajax/illust/123/pages",
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toEqual(expect.objectContaining({ Cookie: "PHPSESSID=test-session" }));
    }
    expect(mocks.downloadToCache.mock.calls.map(([url]) => url)).toEqual([
      pages[1]!.urls.original,
      pages[0]!.urls.original,
    ]);
    for (const [, options] of mocks.downloadToCache.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ Referer: "https://www.pixiv.net/" }),
        }),
      );
      expect(JSON.stringify(options)).not.toContain("PHPSESSID");
      expect(JSON.stringify(options)).not.toContain("test-session");
    }
  });

  it("quality=regular 选用普通尺寸图片", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(artwork())).mockResolvedValueOnce(apiResponse(pages));
    mocks.downloadToCache.mockResolvedValueOnce({ virtualPath: "/images/regular.jpg" });

    const result = await pixivDownload(log).execute!({ illust_id: "123", quality: "regular" }, context);

    expect(mocks.downloadToCache).toHaveBeenCalledOnce();
    expect(mocks.downloadToCache.mock.calls[0]![0]).toBe(pages[0]!.urls.regular);
    expect(result).toMatchObject({ images: [{ page_index: 0, path: "/images/regular.jpg" }], errors: [] });
  });

  it("单页下载失败仍保留其他成功页面的可发送路径", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(artwork())).mockResolvedValueOnce(apiResponse(pages));
    mocks.downloadToCache
      .mockRejectedValueOnce(new Error("图片服务器不可用"))
      .mockResolvedValueOnce({ virtualPath: "/images/second.png" });

    const result = await pixivDownload(log).execute!({ illust_id: "123", page_indexes: [0, 1] }, context);

    expect(result).toMatchObject({
      images: [{ page_index: 1, path: "/images/second.png" }],
      errors: [{ page_index: 0, error: "图片服务器不可用" }],
    });
    expect(mocks.downloadToCache).toHaveBeenCalledTimes(2);
  });

  it("越界页码在下载前整体拒绝", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(artwork())).mockResolvedValueOnce(apiResponse(pages));

    expect(await pixivDownload(log).execute!({ illust_id: "123", page_indexes: [0, 2] }, context)).toEqual({
      error: "Pixiv 下载失败：作品共 2 页，请使用 0 到 1 的页码",
    });
    expect(mocks.downloadToCache).not.toHaveBeenCalled();
  });

  it("动图明确报不支持，且不请求图片页", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(artwork(2)));

    expect(await pixivDownload(log).execute!({ illust_id: "123" }, context)).toEqual({
      error: expect.stringContaining("暂不支持 Pixiv 动图"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.downloadToCache).not.toHaveBeenCalled();
  });

  it("作品 API 报错时不请求图片页或下载", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(null, true, "作品不存在"));

    expect(await pixivDownload(log).execute!({ illust_id: "123" }, context)).toEqual({
      error: "Pixiv 下载失败：作品不存在",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.downloadToCache).not.toHaveBeenCalled();
  });

  it("预先取消时不请求作品或下载图片", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      await pixivDownload(log).execute!({ illust_id: "123" }, { ...context, abortSignal: controller.signal }),
    ).toEqual({ error: "Pixiv 下载失败：请求超时或已取消" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.downloadToCache).not.toHaveBeenCalled();
  });
});
