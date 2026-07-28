import { resolve, basename, posix } from "node:path";
import { dataPath } from "./path";
import { downloadToCache as downloadCacheFile } from "./blob";

/** 图片缓存的真实文件系统目录 */
const IMAGE_CACHE_DIR = dataPath("workspace", "images");
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

export async function downloadToCache(url: string, option: { limit?: number; fallbackExt?: string } = {}) {
  const result = await downloadCacheFile(url, { ...option, cacheDir: IMAGE_CACHE_DIR });
  return { virtualPath: realToVirtualPath(result.fileName), realPath: result.realPath };
}
