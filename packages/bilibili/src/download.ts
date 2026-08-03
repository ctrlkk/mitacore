/**
 * B 站视频下载器
 *
 * 流程：
 *   1. getDownloadUrl 拿到 DASH 流地址（视频 + 音频分开的两个 m4s）
 *   2. 分别下载到临时文件
 *   3. 用 ffmpeg 合并成单个 mp4
 *
 * 老式 FLV/MP4 流则直接下载不分两步。
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";

/** 下载时必需的请求头，缺少 Referer 会 403 */
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://www.bilibili.com",
};

/** 下载流到本地文件（支持断点续传 206） */
async function downloadStream(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) throw new Error("No response body");
  const writer = createWriteStream(dest);
  await pipeline(resp.body as any, writer);
}

/** 生成临时文件路径 */
function getTempPath(ext: string): string {
  const hash = createHash("md5").update(`${Date.now()}-${Math.random()}`).digest("hex");
  return join(tmpdir(), `bili-${hash}${ext}`);
}

/**
 * 用 ffmpeg 合并音视频流（copy 模式，不重新编码，速度极快）
 * 如果 audioPath 为 null，仅做容器复制
 */
function ffmpegMerge(videoPath: string, audioPath: string | null, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-y"];
    args.push("-i", videoPath);
    if (audioPath) {
      args.push("-i", audioPath);
      args.push("-c:v", "copy");
      args.push("-c:a", "copy");
    } else {
      args.push("-c", "copy");
    }
    args.push(outputPath);

    const proc = spawn("ffmpeg", args, { stdio: "pipe" });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}

export interface DownloadOptions {
  /** 画面质量 qn 值（默认 127=最高） */
  quality?: number;
  /** 登录后的 Cookie（含 SESSDATA），无 cookie 只能拿到低画质 */
  cookie?: string;
  /** 进度回调 */
  onProgress?: (phase: string, percent: number) => void;
}

/**
 * 下载 B 站视频到本地
 *
 * @param bvid       - BV 号
 * @param cid        - 分 P ID，来自 getVideoInfo 返回的 pages[].cid
 * @param outputPath - 输出路径，如 "./output.mp4"
 * @param options    - 可选参数
 *
 * 示例：
 * ```
 * await downloadBilibiliVideo("BV1XJ41157tQ", 148338177, "./video.mp4", {
 *   cookie: "SESSDATA=xxx",
 *   onProgress: (phase, pct) => console.log(`${phase}: ${pct}%`),
 * });
 * ```
 */
export async function downloadBilibiliVideo(
  bvid: string,
  cid: number,
  outputPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  const { getDownloadUrl } = await import("./api");
  const streamData = await getDownloadUrl(bvid, cid, options.cookie, options.quality);

  // 单文件流（MP4 或 FLV）：直接下载
  if (streamData.mp4) {
    options.onProgress?.("下载 MP4", 0);
    await downloadStream(streamData.mp4, outputPath);
    options.onProgress?.("下载完成", 100);
    return;
  }

  if (streamData.flv) {
    options.onProgress?.("下载 FLV", 0);
    await downloadStream(streamData.flv, outputPath);
    options.onProgress?.("下载完成", 100);
    return;
  }

  // DASH 流：分离的视频 + 音频，需要合并
  const videos = streamData.video;
  const audios = streamData.audio;

  if (videos.length === 0) throw new Error("No video stream available");

  const bestVideo = videos.reduce((a, b) => (a.quality > b.quality ? a : b));
  const bestAudio = audios.length > 0 ? audios.reduce((a, b) => (a.quality > b.quality ? a : b)) : null;

  const videoTemp = getTempPath(".m4s");
  const audioTemp = bestAudio ? getTempPath(".m4s") : null;

  try {
    options.onProgress?.("下载视频流", 10);
    await downloadStream(bestVideo.url, videoTemp);

    if (bestAudio) {
      options.onProgress?.("下载音频流", 50);
      await downloadStream(bestAudio.url, audioTemp!);
    }

    options.onProgress?.("合并音视频", 80);
    await ffmpegMerge(videoTemp, audioTemp, outputPath);
    options.onProgress?.("完成", 100);
  } finally {
    // 清理临时文件
    await unlink(videoTemp).catch(() => {});
    if (audioTemp) await unlink(audioTemp).catch(() => {});
  }
}
