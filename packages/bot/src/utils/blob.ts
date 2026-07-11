import { Buffer } from "node:buffer";

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
