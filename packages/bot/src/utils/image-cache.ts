import { mkdir, rename, unlink } from "node:fs/promises";
import { resolve, basename, posix, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { extension } from "mime-types";
import { dataPath } from "./path";
import { createWriteStream } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
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
 * 下载图片到缓存目录
 * 如果图片已存在，直接返回缓存路径
 * @param url 图片 URL
 * @param option 下载选项
 * @param option.limit 最大下载大小（字节），默认 20MB
 * @returns 图片缓存路径
 */
export async function downloadToCache(url: string, option: { limit?: number } = {}) {
  const limit = option.limit ?? 20 * 1024 * 1024; // 20 MB

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  if (!response.body) throw new Error("空的响应体");

  const contentType = response.headers.get("content-type") || undefined;
  const ext = (contentType ? extension(contentType) : false) || "jpg";

  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  const tempFilename = `${randomUUID()}.${ext}.tmp`;
  const tempPath = join(IMAGE_CACHE_DIR, tempFilename);

  // pipeline 自动处理背压、错误传递与流关闭：transform 报错时会销毁整条管道，
  // 文件句柄随之释放，避免 finally 中 unlink 因句柄未释放而 EBUSY/EPERM
  const hasher = createHash("sha256");
  let receivedLength = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      receivedLength += chunk.length;
      if (receivedLength > limit) {
        return callback(new Error(`下载大小超过限制: ${receivedLength} > ${limit}`));
      }
      hasher.update(chunk);
      callback(null, chunk);
    },
  });

  let isFileFinalized = false; // 标记临时文件是否已成功处理(rename 或 冲突清理)

  try {
    await pipeline(Readable.fromWeb(response.body), transform, createWriteStream(tempPath));

    const hashHex = hasher.digest("hex").slice(0, 12);
    const encoded = bs58.encode(Buffer.from(hashHex, "hex"));
    const finalFilename = `${encoded}.${ext}`;
    const finalPath = resolve(IMAGE_CACHE_DIR, finalFilename);

    try {
      await rename(tempPath, finalPath);
    } catch (err: unknown) {
      // Windows 下如果文件已存在会抛出 EEXIST
      // 其它错误严重性不高，不做处理，一并删除
      await unlink(tempPath);
    }

    // 只有执行到这里（rename 成功，或冲突被妥善处理），文件才算真正落地
    isFileFinalized = true;

    return {
      virtualPath: realToVirtualPath(finalFilename),
      realPath: finalPath,
    };
  } finally {
    // pipeline 完成或抛出错误时，所有流均已关闭，此处 unlink 不会触发句柄竞态
    if (!isFileFinalized) {
      await unlink(tempPath).catch(() => {});
    }
  }
}
