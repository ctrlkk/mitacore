import { openAsBlob } from "node:fs";
import { resolve } from "node:path";
import { contentType, lookup } from "mime-types";
import { access } from "node:fs/promises";

/**
 * 将文件系统中的文件打开为标准 File，并根据扩展名补充 MIME 类型
 */
export async function createFsFile(path: string): Promise<File> {
  const filePath = resolve(path);
  const mime = lookup(filePath);
  const type = (mime && contentType(mime)) || "";
  return new File([await openAsBlob(filePath, { type })], filePath, { type });
}

export async function exists(path: string): Promise<boolean> {
  return access(resolve(path)).then(
    () => true,
    () => false,
  );
}
