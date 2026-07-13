/**
 * NapCat 进程 PID 持久化文件
 *
 * 记录上次启动 NapCat 时的关键 PID，用于下次启动前做精确的孤儿清理。
 * 文件路径：dataPath("runtime", "napcat", `<qqId>.pid`)
 *
 * 字段：
 * - launcher: NapCatWinBootMain.exe / qq / xvfb-run 的 PID
 * - qq:       解析 Main Process ID 拿到的 QQ 主进程 PID（解析不到则为 0）
 * - port:     webui 端口，用于端口占用反查兜底
 * - createdAt: 落盘时间戳（毫秒）
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dataPath } from "@/utils/path";

export interface PidRecord {
  launcher: number;
  qq: number;
  port: number;
  createdAt: number;
}

function pidFilePath(qqId: string): string {
  return dataPath("runtime", "napcat", `${qqId}.pid`);
}

export function readPidFile(qqId: string): PidRecord | null {
  const path = pidFilePath(qqId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Number.isFinite(parsed.launcher) &&
      Number.isFinite(parsed.port)
    ) {
      return {
        launcher: parsed.launcher | 0,
        qq: Number.isFinite(parsed.qq) ? (parsed.qq | 0) : 0,
        port: parsed.port | 0,
        createdAt: Number.isFinite(parsed.createdAt) ? (parsed.createdAt | 0) : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePidFile(qqId: string, rec: PidRecord): void {
  const path = pidFilePath(qqId);
  writeFileSync(path, JSON.stringify({ ...rec, createdAt: rec.createdAt || Date.now() }));
}

export function deletePidFile(qqId: string): void {
  const path = pidFilePath(qqId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
