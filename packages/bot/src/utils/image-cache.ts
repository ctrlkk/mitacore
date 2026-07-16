import { readFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, parse, basename, posix, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { extension } from "mime-types";
import { download, blobToDataURL } from "./blob";
import { dataPath } from "./path";
import bs58 from "bs58";

/** 图片缓存的真实文件系统目录 */
const IMAGE_CACHE_DIR = dataPath("images");
const IMAGE_VIRTUAL_PREFIX = "/images/";

/**
 * 将任意路径规范化为虚拟路径
 * 无论输入 `image/a.png`、`a.png`、`/images/a.png`、`/root/a.png`，
 * 都只取文件名，返回 `/images/a.png`，防止越权访问
 */
export function sanitizeImagePath(raw: string): string {
  const filename = basename(raw);
  return realToVirtualPath(filename);
}

/**
 * 虚拟路径 → 真实文件系统路径
 * `/images/abc.jpg` → `/abs/path/data/images/abc.jpg`
 */
export function virtualToRealPath(virtualPath: string): string {
  return resolve(IMAGE_CACHE_DIR, basename(virtualPath));
}

/**
 * 真实文件系统路径 → 虚拟路径
 * `abc.jpg` → `/images/abc.jpg`
 */
function realToVirtualPath(filename: string): string {
  return posix.join(IMAGE_VIRTUAL_PREFIX, filename);
}

/**
 * Buffer → Base64 Data URL
 * 统一的 base64 编码逻辑，替换 images.ts 中贴纸/缓存图片两处重复代码
 */
function bufferToDataUrl(buffer: Buffer, filename: string): string {
  const ext = parse(filename).ext.slice(1); // "png" | "jpg" | ...
  const mime = ext === "jpg" ? "jpeg" : ext;
  return `data:image/${mime};base64,${buffer.toString("base64")}`;
}

/**
 * 从缓存目录读取图片并转为 Data URL
 * 若文件不存在返回 null
 */
export async function readCachedImageAsDataUrl(virtualPath: string): Promise<string | null> {
  const realPath = virtualToRealPath(virtualPath);
  try {
    const buffer = await readFile(realPath);
    const filename = basename(virtualPath);
    return bufferToDataUrl(buffer, filename);
  } catch {
    return null;
  }
}

/**
 * 下载远程图片并转换为 base64 Data URL
 * @param url 远程图片链接
 * @returns base64 Data URL，失败返回 null
 */
export async function downloadImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const blob = await download(url, { limit: 3 * 1024 * 1024 });
    const dataUrl = await blobToDataURL(blob);
    return dataUrl;
  } catch {
    return null;
  }
}

export async function downloadToCache(url: string, option: { limit?: number } = {}) {
  const limit = option.limit ?? 20 * 1024 * 1024; // 20 MB

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("空的响应体");
  }

  const contentType = response.headers.get("content-type") || undefined;
  const ext = (contentType ? extension(contentType) : false) || "jpg";

  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  const tempFilename = `${randomUUID()}.download`;
  const tempPath = join(IMAGE_CACHE_DIR, tempFilename);

  const sink = Bun.file(tempPath).writer();
  const hasher = createHash("sha256");
  const reader = response.body.getReader();
  let receivedLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 边写盘边算 hash
      sink.write(value);
      hasher.update(value);

      receivedLength += value.length;
      if (receivedLength > limit) {
        await reader.cancel();
        throw new Error(`下载大小超过限制: ${receivedLength} > ${limit}`);
      }
    }

    await sink.end();

    const hashHex = hasher.digest("hex").slice(0, 12);
    const encoded = bs58.encode(Buffer.from(hashHex, "hex"));
    const finalFilename = `${encoded}.${ext}`;
    const finalPath = resolve(IMAGE_CACHE_DIR, finalFilename);

    try {
      await rename(tempPath, finalPath);
    } catch {
      await unlink(tempPath);
    }
    return {
      virtualPath: realToVirtualPath(finalFilename),
      realPath: finalPath,
    };
  } catch (err) {
    await sink.end();
    await unlink(tempPath);
    throw err;
  }
}
