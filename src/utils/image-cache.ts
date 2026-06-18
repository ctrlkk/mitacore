import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, parse, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { extension } from "mime-types";
import bs58 from "bs58";

/** 图片缓存的真实文件系统目录 */
const IMAGE_CACHE_DIR = resolve(".cache", "images");
const IMAGE_VIRTUAL_PREFIX = "/images/";

/**
 * 虚拟路径 → 真实文件系统路径
 * `/images/abc.jpg` → `/abs/path/.cache/images/abc.jpg`
 */
export function virtualToRealPath(virtualPath: string): string {
  const filename = basename(virtualPath);
  return resolve(IMAGE_CACHE_DIR, filename);
}

/**
 * 真实文件系统路径 → 虚拟路径
 * `abc.jpg` → `/images/abc.jpg`
 */
function realToVirtualPath(filename: string): string {
  return join(IMAGE_VIRTUAL_PREFIX, filename);
}

/**
 * 判断是否为虚拟图片路径
 */
export function isVirtualImagePath(path: string): boolean {
  return path.startsWith(IMAGE_VIRTUAL_PREFIX);
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
export async function readCachedImageAsDataUrl(
  virtualPath: string,
): Promise<string | null> {
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
export async function saveBufferToCache(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const hash = createHash("sha256")
    .update(buffer)
    .digest("hex")
    .slice(0, 12);
  const encoded = bs58.encode(Buffer.from(hash, "hex"));
  const ext = extension(mimeType) || "jpg";
  const filename = `${encoded}.${ext}`;

  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  await writeFile(resolve(IMAGE_CACHE_DIR, filename), buffer);

  return realToVirtualPath(filename);
}
