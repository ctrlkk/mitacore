import type { BunFile } from "bun";
import { formatBytes } from "./format";
import { findExecutable } from "./find-executable";
import { logger } from "@/logger";

const MAX_DIM = 720;
const MIN_COMPRESS_SIZE = 512 * 1024; // 视频建议大于 500KB 再压缩

/**
 * 使用 ffmpeg 转码并压缩视频
 * - 缩放至 MAX_DIM 以内（保持比例）
 * - 转码为 H.264 / AAC (MP4)
 * - 使用 fast preset加速编码
 */
async function transcodeVideo(file: BunFile): Promise<Blob> {
  const ffmpeg = findExecutable("ffmpeg");
  if (!ffmpeg) {
    logger.warn("未找到 ffmpeg 可执行文件，视频将透传处理");
    return file;
  }

  try {
    // 关键参数说明：
    // -i -: 从 stdin 读取
    // -vf scale: 等比缩放，如果超过 MAX_DIM 则限制，不放大
    // -c:v libx264: 使用 H.264 编码
    // -preset fast: 编码速度与压缩率的平衡
    // -crf 28: 恒定质量因子 (23默认, 28压缩率更高，体积更小)
    // -movflags frag_keyframe+empty_moov: 允许 MP4 流式输出到管道
    // -c:a aac: 音频转 AAC
    // -f mp4: 强制输出格式为 MP4
    const proc = Bun.spawn({
      cmd: [
        ffmpeg,
        "-i",
        "-",
        "-vf",
        `scale='if(gte(iw,ih),min(${MAX_DIM},iw),-2)':'if(gte(iw,ih),-2,min(${MAX_DIM},ih))'`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "28",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "-",
      ],
      stdin: file.stream(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const buffer = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || buffer.byteLength === 0) {
      const stderrText = await new Response(proc.stderr).text();
      logger.warn({ exitCode, stderr: stderrText }, "ffmpeg 处理失败");
      return file;
    }

    const result = new Blob([buffer], { type: "video/mp4" });
    logger.info(
      {
        file: file.name,
        originalBytes: formatBytes(file.size),
        compressedBytes: formatBytes(result.size),
      },
      "视频压缩",
    );

    return result.size < file.size ? result : file;
  } catch (error) {
    logger.warn({ error }, "视频处理失败");
    return file;
  }
}

/**
 * 视频压缩入口
 * 仅处理常见视频格式，小文件透传
 */
export async function compressVideo(file: BunFile): Promise<Blob> {
  const supported = new Set([
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo", // .avi
    "video/x-matroska", // .mkv
  ]);

  if (!supported.has(file.type)) return file;
  if (file.size < MIN_COMPRESS_SIZE) return file;

  return transcodeVideo(file);
}
