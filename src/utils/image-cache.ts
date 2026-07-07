import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, parse, basename, posix } from "node:path";
import { createHash } from "node:crypto";
import { extension } from "mime-types";
import { download, blobToDataURL } from "./blob";
import bs58 from "bs58";
import { dataPath } from "./path";

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
 * 将图片 Buffer 存入缓存目录，返回虚拟路径
 * 从 index.ts 的 processImageAssets 中提取
 */
export async function saveBufferToCache(buffer: Buffer, mimeType: string): Promise<string> {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const encoded = bs58.encode(Buffer.from(hash, "hex"));
  const ext = extension(mimeType) || "jpg";
  const filename = `${encoded}.${ext}`;

  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  await writeFile(resolve(IMAGE_CACHE_DIR, filename), buffer);

  return realToVirtualPath(filename);
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
