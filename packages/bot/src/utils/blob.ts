import { Buffer } from "node:buffer";
import { mkdir, rename, unlink, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { extension } from "mime-types";
import { createWriteStream } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import bs58 from "bs58";

/**
 * 将Base64字符串转换为Blob对象
 * @param base64 Base64编码的字符串
 * @param mimeType MIME类型，默认为 'application/octet-stream'
 * @returns 返回转换后的Blob对象
 */
export function base64ToBlob(base64: string, mimeType: string = "application/octet-stream"): Blob {
  // 解码Base64字符串
  const byteCharacters = atob(base64);
  const byteNumbers: number[] = Array.from({ length: byteCharacters.length });

  // 转换为字节数组
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }

  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

/**
 * 将Blob对象转换为Data URL格式
 * @param blob 要转换的Blob对象
 * @returns 返回Base64编码的Data URL字符串
 */
export async function blobToDataURL(blob: Blob): Promise<string> {
  const buffer = await blob.bytes();
  return `data:${blob.type};base64,${buffer.toBase64()}`;
}

/**
 * 将Data URL转换为Blob对象
 * @param dataURL Data URL格式的字符串
 * @returns 返回转换后的Blob对象
 */
export function dataURLToBlob(dataURL: string): Blob {
  const arr = dataURL.split(",");
  const mime = arr[0]?.match(/:(.*?);/)![1];
  const bstr = atob(arr[1] || "");
  let n = bstr.length;
  const u8arr = new Uint8Array(n);

  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }

  return new Blob([u8arr], { type: mime });
}

/**
 * 下载一个网络文件
 * @param url 链接
 * @returns 一个Blob对象
 */
export async function download(url: string, option: { limit?: number } = {}): Promise<Blob> {
  const limit = option.limit ?? 20 * 1024 * 1024;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("空的响应体");
  }

  const contentType = response.headers.get("content-type") || undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let receivedLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    receivedLength += value.length;
    if (receivedLength > limit) {
      await reader.cancel();
      throw new Error("size limit");
    }
  }
  return new Blob(chunks, { type: contentType });
}

type MagicSignature = {
  ext: string;
  bytes: Array<number | null>;
};

const MAGIC_SIGNATURES: MagicSignature[] = [
  { ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  {
    ext: "webp",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  { ext: "bmp", bytes: [0x42, 0x4d] },

  { ext: "avif", bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] },
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
  {
    ext: "mp4",
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  },
  { ext: "webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { ext: "flv", bytes: [0x46, 0x4c, 0x56] },
  {
    ext: "avi",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x41, 0x56, 0x49, 0x20],
  },
];

function detectExtByMagic(header: Uint8Array): string | undefined {
  for (const signature of MAGIC_SIGNATURES) {
    if (header.length < signature.bytes.length) continue;

    const matched = signature.bytes.every((byte, index) => byte === null || header[index] === byte);
    if (matched) return signature.ext;
  }

  return undefined;
}

/**
 * 下载一个网络文件到缓存目录
 * @param url 链接
 * @param options 选项
 * @param options.cacheDir 缓存目录
 * @param options.limit 下载大小限制
 * @param options.fallbackExt 回退文件扩展名
 * @returns 下载结果
 */
export async function downloadToCache(
  url: string,
  options: {
    cacheDir: string;
    limit?: number;
    fallbackExt?: string;
  },
): Promise<{ realPath: string; fileName: string }> {
  const limit = options.limit ?? 20 * 1024 * 1024;
  const fallbackExt = options.fallbackExt ?? "jpg";

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  if (!response.body) throw new Error("空的响应体");

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;

  await mkdir(options.cacheDir, { recursive: true });
  const tempFilename = `${randomUUID()}.tmp`;
  const tempPath = join(options.cacheDir, tempFilename);

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

  let isFileFinalized = false;

  try {
    await pipeline(Readable.fromWeb(response.body), transform, createWriteStream(tempPath));

    const fileHandle = await open(tempPath, "r");
    const header = new Uint8Array(64);
    await fileHandle.read(header, 0, 64, 0);
    await fileHandle.close();

    const contentTypeExt = contentType && contentType !== "application/octet-stream" ? extension(contentType) : false;
    const ext = detectExtByMagic(header) ?? contentTypeExt ?? fallbackExt;

    const hashHex = hasher.digest("hex").slice(0, 12);
    const encoded = bs58.encode(Buffer.from(hashHex, "hex"));
    const finalFilename = `${encoded}.${ext}`;
    const finalPath = resolve(options.cacheDir, finalFilename);

    try {
      await rename(tempPath, finalPath);
    } catch {
      await unlink(tempPath);
    }

    isFileFinalized = true;

    return { realPath: finalPath, fileName: finalFilename };
  } finally {
    if (!isFileFinalized) {
      await unlink(tempPath).catch(() => {});
    }
  }
}
