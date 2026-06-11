/**
 * B 站视频 API 封装
 *
 * 核心流程：
 *   extractVideoId → getVideoInfo（获取分 P 信息）→ getDownloadUrl（拿到音视频流地址）
 */

import { bvid2aid } from "./bvid";
import { getMixinKey, encWbi, resetMixinKey } from "./wbi";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://www.bilibili.com",
};

/** 通用 GET 请求封装，自动抛异常（code !== 0 时） */
async function apiGet(url: string, params: Record<string, any>, cookie?: string): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { ...HEADERS };
  if (cookie) headers.Cookie = cookie;
  const resp = await fetch(`${url}?${qs}`, { headers });
  const json = await resp.json() as any;
  if (json.code !== 0) {
    throw new Error(`Bilibili API error: ${json.code} ${json.message}`);
  }
  return json.data;
}

export interface VideoPage {
  /** 分 P 的唯一 ID，获取下载地址时需要 */
  cid: number;
  /** 分 P 序号，从 1 开始 */
  page: number;
  /** 分 P 标题 */
  part: string;
  /** 时长（秒） */
  duration: number;
}

export interface VideoInfo {
  bvid: string;
  aid: number;
  title: string;
  /** 分 P 列表，多 P 视频每个 page 代表一集/一段 */
  pages: VideoPage[];
  owner: { mid: number; name: string; face: string };
  desc: string;
  pic: string;
  duration: number;
}

/**
 * 获取视频基本信息（标题、分 P、时长、UP 主等）
 *
 * 调用 `GET /x/web-interface/view?bvid=xxx`
 */
export async function getVideoInfo(bvid: string, cookie?: string): Promise<VideoInfo> {
  const data = await apiGet("https://api.bilibili.com/x/web-interface/view", { bvid }, cookie);
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    pages: data.pages.map((p: any) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
    owner: data.owner,
    desc: data.desc,
    pic: data.pic,
    duration: data.duration,
  };
}

/**
 * API 返回的流数据结构
 *
 * 现代 B 站视频使用 DASH 流（音视频分离），需要分别下载再合并。
 * 老视频/低清可能返回单一的 flv 或 mp4 流。
 */
export interface StreamData {
  /** DASH 视频流列表（多个清晰度/编码） */
  video: { url: string; quality: number; codecs: string }[];
  /** DASH 音频流列表 */
  audio: { url: string; quality: number }[];
  /** 老式 FLV 流（DASH 不存在时） */
  flv?: string;
  /** HTML5 MP4 流（仅 html5 模式） */
  mp4?: string;
}

/**
 * 获取视频下载流地址
 *
 * 调用 `GET /x/player/wbi/playurl`（需要 WBI 签名）
 *
 * @param bvid   - BV 号
 * @param cid    - 分 P ID，来自 getVideoInfo().pages[].cid
 * @param cookie - 可选，带 SESSDATA 可获取更高画质
 * @param qn     - 画质等级 (127=8K, 126=杜比, 125=HDR, 120=4K, 116=1080P60, 112=1080P+, 80=1080P, 64=720P, 32=480P, 16=360P)
 * @param fnval  - 流格式 (4048 = DASH+HDR+杜比+8K)
 */
export async function getDownloadUrl(
  bvid: string,
  cid: number,
  cookie?: string,
  qn: number = 127,
  fnval: number = 4048,
): Promise<StreamData> {
  const params: Record<string, any> = {
    avid: bvid2aid(bvid),
    bvid,
    cid,
    qn,
    fnval,
    fnver: 0,
    fourk: 1,
    gaia_source: "pre-load",
    from_client: "BROWSER",
    web_location: 1315873,
    isGaiaAvoided: "true",
  };

  const mixinKey = await getMixinKey(cookie);
  const signed = encWbi(params, mixinKey);

  try {
    const data = await apiGet("https://api.bilibili.com/x/player/wbi/playurl", signed, cookie);

    const result: StreamData = { video: [], audio: [] };

    if (data.dash) {
      // DASH 流（主流）：视频和音频分开，通常有多个清晰度可选
      for (const v of data.dash.video || []) {
        result.video.push({
          url: v.baseUrl || v.base_url,
          quality: v.id,
          codecs: v.codecs,
        });
      }
      for (const a of data.dash.audio || []) {
        result.audio.push({
          url: a.baseUrl || a.base_url,
          quality: a.id,
        });
      }
    }

    if (data.durl) {
      // 老式 FLV/MP4 流（DASH 不存在时退化）
      if (data.format?.startsWith("flv")) {
        result.flv = data.durl[0]?.url;
      } else {
        result.mp4 = data.durl[0]?.url;
      }
    }

    return result;
  } catch (e: any) {
    // -403 通常是 wbi_key 过期，清缓存下次重试
    if (e.message?.includes("-403")) {
      resetMixinKey();
    }
    throw e;
  }
}
