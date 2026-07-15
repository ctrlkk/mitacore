import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { logger } from "@/logger";

/**
 * 从 GitHub Releases 下载 NapCat.Shell.zip，镜像回退避免 GFW 干扰。
 * 支持断点续传。后置条件：解压完成后删除临时 zip 文件，不保留残留。
 */
export async function downloadNapcat(
  targetDir: string,
  onProgress?: (received: number, total: number) => void,
  onDownloadComplete?: () => void,
): Promise<void> {
  // 使用固定的文件名以便支持断点续传
  const zipPath = join(targetDir, "NapCat.Shell.zip.part");
  mkdirSync(targetDir, { recursive: true });

  const NAPCAT_DOWNLOAD_URL = "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip";
  const NAPCAT_MIRROR_URLS = [
    "https://gh.ddlc.top/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip",
    "https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip",
    "https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip",
  ];
  const candidates = [NAPCAT_DOWNLOAD_URL, ...NAPCAT_MIRROR_URLS];

  let downloaded = false;
  let lastError = "";

  // 检查已下载的临时文件大小
  let startByte = 0;
  if (existsSync(zipPath)) {
    startByte = statSync(zipPath).size;
  }

  for (const url of candidates) {
    try {
      logger.info({ url, startByte }, "下载 NapCat");

      const headers = new Headers();
      if (startByte > 0) {
        headers.set("Range", `bytes=${startByte}-`);
      }

      const resp = await fetch(url, { headers });

      // 206 表示支持断点续传并返回了请求的范围；200 表示服务器忽略了 Range 请求，需从头开始下载
      const isResuming = resp.status === 206;
      if (!isResuming && startByte > 0) {
        logger.warn({ url, status: resp.status }, "下载源不支持断点续传或资源已更新，从头开始下载");
        startByte = 0;
      }

      if (!resp.ok || !resp.body) {
        lastError = `HTTP ${resp.status}`;
        logger.warn({ url, status: resp.status }, "下载源返回非 OK，切换镜像");
        continue;
      }

      const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
      const total = isResuming ? contentLength + startByte : contentLength;
      let received = startByte;

      const reader = resp.body.getReader();
      // 根据是否续传决定是追加('a')还是覆盖('w')
      const writer = createWriteStream(zipPath, { flags: isResuming ? "a" : "w" });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (onProgress) onProgress(received, total);
        writer.write(value);
      }

      // 确保文件完全写入磁盘
      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
        writer.end();
      });

      onDownloadComplete?.();
      downloaded = true;
      logger.info({ url, receivedMB: Number((received / 1024 / 1024).toFixed(1)) }, "下载完成");
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.error({ url, error: lastError }, "下载失败");
    }
  }

  if (!downloaded) throw new Error("所有下载源均不可用");

  try {
    logger.info("解压 NapCat 安装包");
    const unzipper = new Unzip((file) => {
      if (file.name.endsWith("/")) {
        file.ondata = () => {};
        file.start();
        return;
      }
      const targetPath = join(targetDir, file.name);
      mkdirSync(dirname(targetPath), { recursive: true });
      const writer = Bun.file(targetPath).writer();
      file.ondata = (err, data, final) => {
        if (err) {
          writer.end();
          throw err;
        }
        if (data.byteLength > 0) writer.write(data);
        if (final) writer.end();
      };
      file.start();
    });
    unzipper.register(UnzipInflate);

    const reader = Bun.file(zipPath).stream().getReader();
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      unzipper.push(result.value ?? new Uint8Array(0), done);
    }
    logger.info("解压完成");
  } finally {
    // 确保删除临时 zip 文件
    try {
      unlinkSync(zipPath);
    } catch {}
  }
}
