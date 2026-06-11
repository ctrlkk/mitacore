/**
 * WBI 签名（B 站 API 的请求鉴权机制）
 *
 * 原理：
 *   1. 从 /x/web-interface/nav 拿到 img_key 和 sub_key
 *   2. 拼接后按固定顺序取字符 → mixin_key（32 位）
 *   3. 对请求参数按 key 排序，拼成 query string，末尾附上 mixin_key
 *   4. 取其 MD5 作为 w_rid，同时附带 wts（unix 时间戳）
 *
 * 部分接口（如获取下载地址）强制要求 WBI 签名，否则返回 -403。
 */

import { createHash } from "node:crypto";

/**
 * mixin_key 的字符选取顺序（固定常量，源自 B 站前端）
 * 从 img_key + sub_key 的拼接字符串中，按此数组下标取字符
 */
const MIXIN_KEY_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 37, 12, 52, 56, 31,
  7, 59, 59, 1, 51, 45, 29, 14, 4, 55, 29, 51, 50, 35, 24, 19,
  26, 44, 22, 58, 5, 11, 36, 33, 48, 30, 35, 42, 45, 20, 54, 43,
];

let cachedMixinKey: string | null = null;

/** 调用 /x/web-interface/nav 获取导航信息（包含 wbi_img） */
async function getNav(credential?: string): Promise<any> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: "https://www.bilibili.com",
  };
  if (credential) {
    headers.Cookie = credential;
  }
  const resp = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers });
  const json = await resp.json() as any;
  return json.data;
}

/** 从服务端获取最新的 mixin_key */
async function getMixinKeyFromServer(credential?: string): Promise<string> {
  const data = await getNav(credential);
  const imgUrl: string = data.wbi_img.img_url;
  const subUrl: string = data.wbi_img.sub_url;

  const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
  const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";

  const ae = imgKey + subKey;
  let le = "";
  for (const i of MIXIN_KEY_ORDER) {
    if (i < ae.length) {
      le += ae[i];
    }
  }
  return le.slice(0, 32);
}

/**
 * 获取 mixin_key（带缓存，首次调用会发请求获取）
 * mixin_key 过期或被服务端拒绝后需要 resetMixinKey 清缓存重取
 */
export async function getMixinKey(credential?: string): Promise<string> {
  if (!cachedMixinKey) {
    cachedMixinKey = await getMixinKeyFromServer(credential);
  }
  return cachedMixinKey;
}

/** 清空缓存的 mixin_key，下次调用 getMixinKey 时会重新请求 */
export function resetMixinKey(): void {
  cachedMixinKey = null;
}

/**
 * 对请求参数进行 WBI 签名，返回原 params（附带 w_rid / wts）
 *
 * @param params   - 请求参数字典
 * @param mixinKey - 由 getMixinKey 获取
 * @returns 添加了 wts 和 w_rid 的 params
 */
export function encWbi(params: Record<string, any>, mixinKey: string): Record<string, any> {
  delete params.w_rid;
  params.wts = Math.floor(Date.now() / 1000);
  const sortedKeys = Object.keys(params).sort();
  const sorted: Record<string, string> = {};
  for (const key of sortedKeys) {
    sorted[key] = String(params[key]);
  }
  const query = new URLSearchParams(sorted).toString();
  const signStr = query + mixinKey;
  params.w_rid = createHash("md5").update(signStr).digest("hex");
  return params;
}
