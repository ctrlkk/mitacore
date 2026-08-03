import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataPath } from "@/utils/path";

export function createWeixinSyncBufferStore(accountId: string) {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const syncPath = dataPath("weixin", "accounts", `${safeAccountId}.sync.json`);

  return {
    async load() {
      try {
        return (JSON.parse(await readFile(syncPath, "utf8")) as { get_updates_buf?: string }).get_updates_buf ?? "";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    },
    async save(value: string) {
      await mkdir(dirname(syncPath), { recursive: true });
      const temporaryPath = `${syncPath}.tmp-${process.pid}`;
      try {
        await writeFile(temporaryPath, JSON.stringify({ get_updates_buf: value }), "utf8");
        await rename(temporaryPath, syncPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}
