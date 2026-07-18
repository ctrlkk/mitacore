import type { BunFile } from "bun";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { formatBytes } from "./format";
import { logger } from "@/logger";

const MAX_DIM = 720;

/**
 * 查找 gifsicle 可执行文件
 * 优先从打包目录的 bin 子目录查找，找不到则回退到系统 PATH
 */
function findGifsicle(): string | null {
  const exeExt = process.platform === "win32" ? ".exe" : "";
  const bundled = resolve(dirname(process.execPath), "bin", `gifsicle${exeExt}`);
  if (existsSync(bundled)) return bundled;
  return Bun.which("gifsicle") ?? null;
}

/**
 * 使用 gifsicle 缩放并压缩 GIF，保留动画
 */
async function resizeGif(file: BunFile): Promise<Blob> {
  const gifsicle = findGifsicle();
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

    const buffer = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || buffer.byteLength === 0) {
      const stderrText = await new Response(proc.stderr).text();
      logger.warn({ exitCode, stderr: stderrText }, "gifsicle 处理失败");
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
 * 按格式选择压缩策略：
 * - GIF → gifsicle（保留动画）
 * - 其他静态图 → Bun.Image（保留原始格式）
 * - 未知格式 → 透传
 */
export async function compressImage(file: BunFile): Promise<Blob> {
  const mimeType = file.type;

  if (mimeType === "image/gif") return resizeGif(file);

  const supported = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
  if (!supported.has(mimeType)) return file;

  try {
    const img = new Bun.Image(file);

    if (img.width > MAX_DIM) {
      img.resize(MAX_DIM);
    }

    switch (mimeType) {
      case "image/jpeg":
        img.jpeg({ quality: 85 });
        break;
      case "image/png":
        img.webp({ quality: 85 });
        break;
      case "image/webp":
        img.webp({ quality: 85 });
        break;
      case "image/bmp":
        img.jpeg({ quality: 85 }); // BMP 转为 JPEG 更节省空间
        break;
      default:
        return file;
    }

    const result = await img.blob();
    logger.info(
      {
        file: file.name,
        originalBytes: formatBytes(file.size),
        compressedBytes: formatBytes(result.size),
      },
      "图片压缩",
    );

    return result.size < file.size ? result : file;
  } catch (error) {
    logger.warn({ error }, "图片处理失败");
    return file;
  }
}
