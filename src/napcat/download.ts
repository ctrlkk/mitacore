import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";

/**
 * 从 GitHub Releases 下载 NapCat.Shell.zip，镜像回退避免 GFW 干扰。
 * 后置条件：解压完成后删除临时 zip 文件，不保留残留。
 */
export async function downloadNapcat(targetDir: string, onProgress?: (pct: number) => void): Promise<void> {
  const zipPath = join(targetDir, `NapCat.Shell.${Date.now()}.zip`);
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

  for (const url of candidates) {
    try {
      console.log(`下载中: ${url}`);
      const resp = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!resp.ok || !resp.body) {
        lastError = `HTTP ${resp.status}`;
        console.log(`HTTP ${resp.status}，切换镜像`);
        continue;
      }

      const total = parseInt(resp.headers.get("content-length") || "0", 10);
      let received = 0;

      const reader = resp.body.getReader();
      const file = Bun.file(zipPath);
      const writer = file.writer();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (total && onProgress) onProgress(Math.round((received / total) * 100));
        writer.write(value);
      }
      writer.end();
      downloaded = true;
      console.log(`下载完成 (${(received / 1024 / 1024).toFixed(1)} MB)`);
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.log(`下载失败: ${lastError}`);
    }
  }

  if (!downloaded) throw new Error("所有下载源均不可用");

  try {
    console.log("解压中…");
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
    console.log("解压完成");
  } finally {
    // 确保删除临时 zip 文件
    try {
      unlinkSync(zipPath);
    } catch {}
  }
}
