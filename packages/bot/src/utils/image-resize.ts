import type { BunFile } from "bun";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { formatBytes } from "./format";
import { logger } from "@/logger";

const MAX_DIM = 720;
const MIN_COMPRESS_SIZE = 50 * 1024;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif"]);

/**
 * 查找图片处理所需的可执行文件
 * 优先从打包目录的 bin 子目录查找，找不到则回退到系统 PATH
 */
function findExecutable(name: "ffmpeg" | "ffprobe" | "gifsicle"): string | null {
  const exeExt = process.platform === "win32" ? ".exe" : "";
  const bundled = resolve(dirname(process.execPath), "bin", `${name}${exeExt}`);
  if (existsSync(bundled)) return bundled;
  return Bun.which(name) ?? null;
}

/**
 * 使用 gifsicle 缩放并压缩 GIF，保留动画
 */
async function resizeGif(file: BunFile): Promise<Blob> {
  const gifsicle = findExecutable("gifsicle");
  if (!gifsicle) {
    logger.warn("未找到 gifsicle 可执行文件，GIF 将透传处理");
    return file;
  }

  try {
    const proc = Bun.spawn({
      cmd: [
        gifsicle,
        `--resize-fit=${MAX_DIM}x${MAX_DIM}`, // 等比缩放，限制在 MAX_DIM 以内
        "--optimize=3", // 无损 LZW 重组优化
        "--lossy=80", // 有损压缩（如果编译版本支持）
        "--no-warnings", // 忽略警告
        "-o",
        "-", // 输出到 stdout
        "-", // 从 stdin 读取
      ],
      stdin: file.stream(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [buffer, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0 || buffer.byteLength === 0) {
      logger.warn({ exitCode, stderr }, "gifsicle 处理失败");
      return file;
    }

    const result = new Blob([buffer], { type: "image/gif" });
    logger.info(
      {
        file: file.name,
        originalBytes: formatBytes(file.size),
        compressedBytes: formatBytes(result.size),
      },
      "GIF压缩",
    );

    return result.size < file.size ? result : file;
  } catch (error) {
    logger.warn({ error }, "GIF处理失败");
    return file;
  }
}

/**
 * 探测 WebP 编码类型，避免将动态 WebP 当作静态图片处理
 */
async function probeWebpCodec(file: Blob): Promise<"webp" | "webp_anim" | null> {
  const ffprobe = findExecutable("ffprobe");
  if (!ffprobe) {
    logger.warn("未找到 ffprobe 可执行文件，WebP 将透传处理");
    return null;
  }

  try {
    const proc = Bun.spawn({
      cmd: [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "json", "-"],
      stdin: file.stream(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      logger.warn({ exitCode, stderr }, "ffprobe 图片探测失败");
      return null;
    }

    const codecName = (JSON.parse(stdout) as { streams?: Array<{ codec_name?: string }> }).streams?.[0]?.codec_name;
    if (codecName === "webp" || codecName === "webp_anim") return codecName;

    logger.warn({ codecName }, "ffprobe 返回了未知的 WebP 编码类型");
    return null;
  } catch (error) {
    logger.warn({ error }, "ffprobe 图片探测失败");
    return null;
  }
}

/**
 * 按格式选择压缩策略：
 * - GIF → gifsicle（保留动画）
 * - JPEG / PNG / WebP → ffmpeg（保持原始格式）
 * - BMP → ffmpeg 转为 JPEG
 * - 未知格式 → 透传
 */
export async function compressImage(file: BunFile): Promise<Blob> {
  if (!SUPPORTED_TYPES.has(file.type)) return file;
  if (file.type === "image/gif") return resizeGif(file);
  if (file.size < MIN_COMPRESS_SIZE) return file;

  const ffmpeg = findExecutable("ffmpeg");
  if (!ffmpeg) {
    logger.warn("未找到 ffmpeg 可执行文件，图片将透传处理");
    return file;
  }

  const webpCodec = file.type === "image/webp" ? await probeWebpCodec(file) : null;
  if (file.type === "image/webp" && !webpCodec) return file;

  // 根据图片类型选择 ffmpeg 编码参数
  const profile = (() => {
    if (file.type === "image/jpeg" || file.type === "image/bmp") {
      return { type: "image/jpeg", args: ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe"] };
    }
    if (file.type === "image/png") {
      return {
        type: "image/png",
        args: ["-frames:v", "1", "-c:v", "png", "-compression_level", "9", "-pred", "mixed", "-f", "image2pipe"],
      };
    }
    if (webpCodec === "webp_anim") {
      return {
        type: "image/webp",
        args: ["-c:v", "libwebp_anim", "-quality", "80", "-fps_mode", "passthrough", "-loop", "0", "-f", "webp"],
      };
    }
    return { type: "image/webp", args: ["-frames:v", "1", "-c:v", "libwebp", "-quality", "80", "-f", "webp"] };
  })();

  try {
    const proc = Bun.spawn({
      cmd: [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "-",
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale='if(gte(iw,ih),min(${MAX_DIM},iw),-2)':'if(gte(iw,ih),-2,min(${MAX_DIM},ih))'`,
        ...profile.args,
        "-",
      ],
      stdin: file.stream(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buffer, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0 || buffer.byteLength === 0) {
      logger.warn({ exitCode, stderr }, "ffmpeg 图片处理失败");
      return file;
    }

    const result = new Blob([buffer], { type: profile.type });

    const compressionRatio = result.size / file.size;

    logger.info(
      {
        file: file.name,
        originalBytes: formatBytes(file.size),
        compressedBytes: formatBytes(result.size),
        compressionRatio,
      },
      "图片压缩",
    );

    return compressionRatio <= 0.95 ? result : file;
  } catch (error) {
    logger.warn({ error }, "图片处理失败");
    return file;
  }
}
