import type { BunFile } from "bun";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { formatBytes } from "./format";
import { logger } from "@/logger";

const MAX_DIM = 1024;

/**
 * 查找 ffmpeg 可执行文件
 * 优先从打包目录的 bin 子目录查找，找不到则回退到系统 PATH
 */
function findFfmpeg(): string | null {
  const exeExt = process.platform === "win32" ? ".exe" : "";
  const bundled = resolve(dirname(process.execPath), "bin", `ffmpeg${exeExt}`);
  if (existsSync(bundled)) return bundled;
  return Bun.which("ffmpeg") ?? null;
}

/**
 * 使用 ffmpeg 缩放 GIF，保留动画
 */
async function resizeGif(file: BunFile): Promise<Blob> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    logger.warn("未找到 ffmpeg，GIF 将不压缩直接使用");
    return file;
  }

  const scaleFilter = `scale='if(gt(iw,${MAX_DIM}),${MAX_DIM},iw)':-1`;
  const filterComplex = `[0:v] ${scaleFilter},split [a][b];[a] palettegen [p];[b][p] paletteuse`;

  const proc = Bun.spawn({
    cmd: [ffmpeg, "-i", "pipe:0", "-lavfi", filterComplex, "-f", "gif", "pipe:1"],
    stdin: file, // 直接将 BunFile 作为输入流，零拷贝传给 ffmpeg
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).blob(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    logger.warn({ exitCode, stderrPreview: stderr.slice(0, 200) }, "ffmpeg 缩放 GIF 失败");
    return file;
  }

  logger.debug(
    {
      file: file.name,
      originalBytes: file.size,
      compressedBytes: stdout.size,
      savedPercent: Number(((1 - stdout.size / file.size) * 100).toFixed(1)),
    },
    "GIF 压缩",
  );
  return stdout.size < file.size ? stdout : file;
}

/**
 * 按格式选择压缩策略：
 * - GIF → ffmpeg（保留动画）
 * - 其他静态图 → Bun.Image（保留原始格式）
 * - 未知格式 → 透传
 */
export async function compressImage(file: BunFile): Promise<Blob> {
  const mimeType = file.type;
  if (file.type === "image/gif") return resizeGif(file);

  const supported = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
  if (!supported.has(file.type)) return file;

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
    logger.debug(
      {
        file: file.name,
        originalBytes: file.size,
        compressedBytes: result.size,
        savedPercent: Number(((1 - result.size / file.size) * 100).toFixed(1)),
      },
      "图片压缩",
    );

    return result.size < file.size ? result : file;
  } catch (error) {
    logger.warn({ error }, "图片处理失败");
    return file;
  }
}
