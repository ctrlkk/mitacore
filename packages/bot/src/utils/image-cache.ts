import { mkdir, rename, unlink, open } from "node:fs/promises";
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
export async function downloadToCache(url: string, option: { limit?: number; fallbackExt?: string } = {}) {
  const limit = option.limit ?? 20 * 1024 * 1024; // 20 MB
  const fallbackExt = option.fallbackExt ?? "jpg";

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  if (!response.body) throw new Error("空的响应体");

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;

  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  const tempFilename = `${randomUUID()}.tmp`;
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

    // 只读取文件头用于 Magic Bytes 识别，避免把整个文件读进内存。
    const fileHandle = await open(tempPath, "r");
    const header = new Uint8Array(64);
    await fileHandle.read(header, 0, 64, 0);
    await fileHandle.close();

    // application/octet-stream 只表示“二进制”，不视为有效类型来源。
    const contentTypeExt = contentType && contentType !== "application/octet-stream" ? extension(contentType) : false;

    const ext = detectExtByMagic(header) ?? contentTypeExt ?? fallbackExt;

    const hashHex = hasher.digest("hex").slice(0, 12);
    const encoded = bs58.encode(Buffer.from(hashHex, "hex"));
    const finalFilename = `${encoded}.${ext}`;
    const finalPath = resolve(IMAGE_CACHE_DIR, finalFilename);

    try {
      await rename(tempPath, finalPath);
    } catch {
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

type MagicSignature = {
  ext: string;
  bytes: Array<number | null>;
};

/**
 * Magic Bytes 签名表。
 * null 表示该位置为任意字节。
 * 命中签名时优先使用签名推断扩展名。
 */
const MAGIC_SIGNATURES: MagicSignature[] = [
  // 图片
  { ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  {
    ext: "webp",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  { ext: "bmp", bytes: [0x42, 0x4d] },

  // ISO Base Media File Format：ftyp 容器
  // 具体 brand 优先于通用 mp4
  {
    ext: "avif",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66],
  },
  {
    ext: "heic",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
  },
  {
    ext: "heif",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31],
  },
  {
    ext: "mov",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20],
  },
  {
    ext: "m4a",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20],
  },

  // 通用 mp4 / m4v / 3gp 等 ftyp 容器，兜底为 mp4
  {
    ext: "mp4",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  },

  // WebM / MKV 同为 EBML 容器，这里优先按 WebM 处理
  { ext: "webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },

  // 视频
  { ext: "flv", bytes: [0x46, 0x4c, 0x56] },
  {
    ext: "avi",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x41, 0x56, 0x49, 0x20],
  },
];

/**
 * 根据文件头 Magic Bytes 推断扩展名。
 * 只读取文件头，不需要把整个文件加载进内存。
 */
function detectExtByMagic(header: Uint8Array): string | undefined {
  for (const signature of MAGIC_SIGNATURES) {
    if (header.length < signature.bytes.length) continue;

    const matched = signature.bytes.every((byte, index) => byte === null || header[index] === byte);
    if (matched) return signature.ext;
  }

  return undefined;
}
