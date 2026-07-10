import { bvid2aid } from "./bvid";

/** BV 号正则：BV + 10 位字母数字 */
const BV_RE = /^BV[a-zA-Z0-9]{10}$/;
/** AV 号正则：大小写不敏感的 av + 数字 */
const AV_RE = /^[Aa][Vv](\d+)$/;

export interface VideoId {
  bvid: string;
  /** 由 bvid2aid 计算得出；如果输入是 AV 号，bvid 为空字符串 */
  aid: number;
}

/**
 * 从任意格式的输入中提取视频 ID
 *
 * 支持的格式：
 *   - 裸 BV 号:  `BV1XJ41157tQ`
 *   - 裸 AV 号:  `av82054919` / `AV82054919`
 *   - 完整 URL:  `https://www.bilibili.com/video/BV1XJ41157tQ`
 *   - 完整 URL:  `https://www.bilibili.com/video/av82054919`
 *   - festival: `https://www.bilibili.com/festival/xxx?bvid=BV1...`
 *
 * 注意：b23.tv 短链接无法在这里解析，需要先用 resolveShortUrl 还原。
 *
 * @param input - 用户输入的任意字符串
 * @returns VideoId 或 null（无法识别）
 */
export function extractVideoId(input: string): VideoId | null {
  const trimmed = input.trim();

  // 裸 BV 号
  if (BV_RE.test(trimmed)) {
    return { bvid: trimmed, aid: bvid2aid(trimmed) };
  }

  // 裸 AV 号
  const avMatch = AV_RE.exec(trimmed);
  if (avMatch && avMatch[1]) {
    return { bvid: "", aid: parseInt(avMatch[1], 10) };
  }

  // 尝试当 URL 解析
  try {
    const urlStr = trimmed.startsWith("http") ? trimmed : `https:${trimmed}`;
    const url = new URL(urlStr);

    // b23 短链跳过（需要 resolveShortUrl）
    if (url.hostname === "b23.tv" || url.hostname === "b23.wtf") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);

    // 优先取 query string 里的 bvid（festival 页面等）
    const bvidParam = url.searchParams.get("bvid");
    if (bvidParam && BV_RE.test(bvidParam)) {
      return { bvid: bvidParam, aid: bvid2aid(bvidParam) };
    }

    // 遍历 path 中的片段
    for (const part of parts) {
      if (BV_RE.test(part)) {
        return { bvid: part, aid: bvid2aid(part) };
      }
      const av = AV_RE.exec(part);
      if (av && av[1]) {
        return { bvid: "", aid: parseInt(av[1], 10) };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * 解析 b23.tv 短链接 → 真实 B 站 URL
 *
 * 发一个 HEAD 请求让服务器 302 跳转，从响应 URL 拿到真实地址。
 * 拿到真实地址后再调 extractVideoId 即可。
 */
export async function resolveShortUrl(shortUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(shortUrl, { method: "HEAD", redirect: "follow" });
    return resp.url;
  } catch {
    return null;
  }
}
