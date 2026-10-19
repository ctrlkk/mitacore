import { tool } from "ai";
import { z } from "zod";
import { logger, type PinoLogger } from "@/logger";
import { downloadToCache } from "@/utils/image-cache";

const PIXIV_ORIGIN = "https://www.pixiv.net";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const MAX_JSON_BYTES = 5 * 1024 * 1024;

let phpsessid: string | undefined = undefined;

const searchResultSchema = z.object({
  illustManga: z.object({
    total: z.number(),
    data: z.array(
      z.object({
        id: z.string(),
        isMasked: z.boolean().optional(),
        title: z.string().optional(),
        userId: z.string().optional(),
        userName: z.string().optional(),
        tags: z.array(z.string()).optional(),
        illustType: z.number().optional(),
        xRestrict: z.number().optional(),
        pageCount: z.number().optional(),
      }),
    ),
  }),
});

const artworkSchema = z.object({
  id: z.string(),
  title: z.string(),
  userId: z.string(),
  userName: z.string(),
  illustType: z.number(),
  xRestrict: z.number(),
  pageCount: z.number(),
  tags: z.object({ tags: z.array(z.object({ tag: z.string() })) }),
});

const pagesSchema = z.array(
  z.object({
    urls: z.object({ original: z.string().url(), regular: z.string().url() }),
    width: z.number(),
    height: z.number(),
  }),
);

function requestSignal(abortSignal: AbortSignal | undefined, timeout: number) {
  const deadline = AbortSignal.timeout(timeout);
  return abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
}

async function requestPixiv(path: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(new URL(path, PIXIV_ORIGIN), {
    headers: {
      Referer: `${PIXIV_ORIGIN}/`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Cookie: `PHPSESSID=${phpsessid}`,
    },
    signal,
    // 登录重定向不是有效的 API 响应，也不应继续携带 Cookie 请求其他站点。
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Pixiv 返回 HTTP ${response.status}；请检查网络连接与访问权限`);
  }
  if (!response.body) throw new Error("Pixiv 返回空响应");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Pixiv 响应超过 5 MiB 限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const envelope = z
    .object({ error: z.boolean(), message: z.string().optional(), body: z.unknown() })
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (envelope.error) throw new Error(envelope.message || "Pixiv 请求失败");
  return envelope.body;
}

function failure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "请求超时或已取消";
  if (error instanceof z.ZodError) return "Pixiv 响应格式不符合预期";
  return error instanceof Error ? error.message : "未知错误";
}

export function pixivSearch(log: PinoLogger = logger) {
  return tool({
    description:
      "按关键词搜索 Pixiv 插画和漫画，返回作品 ID、标题、作者、标签、页数与分级。未配置 Cookie 时匿名访问公开作品，配置后使用登录态。关键词按标签部分匹配，可用空格组合标签；优先使用日文或作品常用标签。搜索不会下载图片，选中作品后使用 pixiv_download；动图暂不支持下载。",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(200).describe("搜索关键词或标签"),
      page: z.number().int().min(1).max(1000).optional().describe("Pixiv 搜索页码，从 1 开始，默认 1"),
      limit: z.number().int().min(1).max(20).optional().describe("本页最多返回多少个作品，默认 10"),
      mode: z.enum(["all", "safe", "r18"]).optional().describe("分级筛选，默认 all；可见范围受账号权限影响"),
    }),
    async execute({ query, page = 1, limit = 10, mode = "all" }, { abortSignal }) {
      const signal = requestSignal(abortSignal, 30_000);
      try {
        const params = new URLSearchParams({ word: query, p: String(page), mode, s_mode: "s_tag", type: "all" });
        const body = searchResultSchema.parse(
          await requestPixiv(`/ajax/search/artworks/${encodeURIComponent(query)}?${params}`, signal),
        );
        return {
          query,
          page,
          total: body.illustManga.total,
          results: body.illustManga.data
            .filter((item) => !item.isMasked && item.title !== undefined)
            .slice(0, limit)
            .map((item) => ({
              illust_id: item.id,
              title: item.title,
              author_id: item.userId,
              author: item.userName,
              tags: item.tags,
              illust_type: item.illustType,
              x_restrict: item.xRestrict,
              page_count: item.pageCount,
              url: `${PIXIV_ORIGIN}/artworks/${item.id}`,
            })),
        };
      } catch (error) {
        log.error({ err: error }, "Pixiv 搜索失败");
        return { error: `Pixiv 搜索失败：${failure(error, signal)}` };
      }
    },
  });
}

export function pixivDownload(log: PinoLogger = logger) {
  return tool({
    description:
      "按作品 ID 下载选中的 Pixiv 图片到本地缓存，返回标题、作者、标签和可发送的 /images/... 路径。公开作品可匿名下载，需要登录权限的作品须配置 Cookie。默认只下载第 1 页原图，每张最多 20 MiB；可指定多页或 regular 尺寸。页码从 0 开始，暂不支持动图。将成功的图片路径和作品来源交给 submit_plan，并要求 reply agent 使用 ![说明](/images/文件名) 发送；不要直接发送 pximg URL，它需要防盗链请求头。",
    inputSchema: z.object({
      illust_id: z.string().regex(/^\d+$/).describe("Pixiv 作品 ID，来自搜索结果或作品链接中的数字"),
      page_indexes: z
        .array(z.number().int().min(0))
        .min(1)
        .max(10)
        .optional()
        .describe("要下载的页码，从 0 开始，默认 [0]；每次最多 10 页"),
      quality: z.enum(["original", "regular"]).optional().describe("图片尺寸，默认 original 原图"),
    }),
    async execute({ illust_id, page_indexes = [0], quality = "original" }, { abortSignal }) {
      const signal = requestSignal(abortSignal, 120_000);
      try {
        const artwork = artworkSchema.parse(await requestPixiv(`/ajax/illust/${illust_id}`, signal));
        if (artwork.illustType === 2) throw new Error("暂不支持 Pixiv 动图，请选择插画或漫画");
        const pages = pagesSchema.parse(await requestPixiv(`/ajax/illust/${illust_id}/pages`, signal));
        const indexes = [...new Set(page_indexes)];
        if (indexes.some((index) => index >= pages.length)) {
          throw new Error(`作品共 ${pages.length} 页，请使用 0 到 ${pages.length - 1} 的页码`);
        }

        const images: { page_index: number; path: string; width: number; height: number }[] = [];
        const errors: { page_index: number; error: string }[] = [];
        for (const index of indexes) {
          const page = pages[index]!;
          try {
            const url = new URL(page.urls[quality]);
            if (url.protocol !== "https:" || !url.hostname.endsWith(".pximg.net")) {
              throw new Error("图片地址不是 Pixiv 图片服务器");
            }
            // PHPSESSID 只用于 Pixiv API，图片 CDN 仅需 Referer。
            const cached = await downloadToCache(url.href, {
              limit: 20 * 1024 * 1024,
              headers: { Referer: `${PIXIV_ORIGIN}/`, "User-Agent": USER_AGENT },
              signal,
            });
            images.push({ page_index: index, path: cached.virtualPath, width: page.width, height: page.height });
          } catch (error) {
            log.error({ err: error, illustId: illust_id, pageIndex: index }, "Pixiv 图片下载失败");
            errors.push({ page_index: index, error: failure(error, signal) });
            if (signal.aborted) break;
          }
        }
        return {
          illust_id: artwork.id,
          title: artwork.title,
          author_id: artwork.userId,
          author: artwork.userName,
          tags: artwork.tags.tags.map((tag) => tag.tag),
          page_count: artwork.pageCount,
          x_restrict: artwork.xRestrict,
          url: `${PIXIV_ORIGIN}/artworks/${artwork.id}`,
          images,
          errors,
        };
      } catch (error) {
        log.error({ err: error, illustId: illust_id }, "Pixiv 作品获取失败");
        return { error: `Pixiv 下载失败：${failure(error, signal)}` };
      }
    },
  });
}
