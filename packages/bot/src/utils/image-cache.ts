import { mkdir, rename, unlink } from "node:fs/promises";
import { resolve, basename, posix, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { extension } from "mime-types";
import { dataPath } from "./path";
import bs58 from "bs58";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

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
 * 类型守卫：判断未知错误是否为 Node.js 文件系统冲突错误 (EPERM / EEXIST)
 */
function isFsConflictError(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const sysErr = err as NodeJS.ErrnoException;
    return sysErr.code === "EPERM" || sysErr.code === "EEXIST";
  }
  return false;
}

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

  const stream = createWriteStream(tempPath);
  const hasher = createHash("sha256");
  let receivedLength = 0;

  let isStreamFinished = false; // 标记网络流和文件流是否正常结束
  let isFileFinalized = false; // 标记临时文件是否已成功处理(rename 或 冲突清理)

  try {
    for await (const chunk of response.body) {
      receivedLength += chunk.length;

      if (receivedLength > limit) {
        if (response.body.cancel) {
          await response.body.cancel("文件大小超过限制");
        }
        stream.destroy(new Error(`下载大小超过限制: ${receivedLength} > ${limit}`));
        throw new Error(`下载大小超过限制: ${receivedLength} > ${limit}`);
      }

      stream.write(chunk);
      hasher.update(chunk);
    }

    // 确保数据完全刷入磁盘
    await finished(stream.end());
    isStreamFinished = true;

    const hashHex = hasher.digest("hex").slice(0, 12);
    const encoded = bs58.encode(Buffer.from(hashHex, "hex"));
    const finalFilename = `${encoded}.${ext}`;
    const finalPath = resolve(IMAGE_CACHE_DIR, finalFilename);

    try {
      await rename(tempPath, finalPath);
    } catch (err: unknown) {
      if (!isFsConflictError(err)) {
        throw err;
      }
      await unlink(tempPath);
    }

    // 只有执行到这里（rename 成功，或冲突被妥善处理），文件才算真正落地
    isFileFinalized = true;

    return {
      virtualPath: realToVirtualPath(finalFilename),
      realPath: finalPath,
    };
  } catch (err: unknown) {
    if (!isStreamFinished) {
      const destroyErr = err instanceof Error ? err : undefined;
      stream.destroy(destroyErr);
    }
    throw err;
  } finally {
    if (!isFileFinalized) {
      await unlink(tempPath);
    }
  }
}
