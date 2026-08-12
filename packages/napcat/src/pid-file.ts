/**
 * NapCat 进程 PID 持久化文件
 *
 * 记录当前 NapCat 实例的关键 PID，用于运行状态诊断和清理过期记录。
 * 文件路径：dataPath("runtime", "napcat", `<qqId>.pid`)
 *
 * 字段：
 * - launcher: napcat-supervisor 的 PID
 * - qq:       解析 Main Process ID 拿到的 QQ 主进程 PID（解析不到则为 0）
 * - port:     webui 端口
 * - createdAt: 落盘时间戳（毫秒）
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export interface PidRecord {
  launcher: number;
  qq: number;
  port: number;
  createdAt: number;
}

function pidFilePath(runtimeDir: string, qqId: string): string {
  return resolve(runtimeDir, `${qqId}.pid`);
}

export function napcatLockPath(runtimeDir: string, qqId: string): string {
  return resolve(runtimeDir, `${qqId}.lock`);
}

export function readPidFile(runtimeDir: string, qqId: string): PidRecord | null {
  const path = pidFilePath(runtimeDir, qqId);
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
        launcher: Math.trunc(parsed.launcher),
        qq: Number.isFinite(parsed.qq) ? Math.trunc(parsed.qq) : 0,
        port: Math.trunc(parsed.port),
        createdAt: Number.isFinite(parsed.createdAt) ? Math.trunc(parsed.createdAt) : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePidFile(runtimeDir: string, qqId: string, rec: PidRecord): void {
  const path = pidFilePath(runtimeDir, qqId);
  writeFileSync(path, JSON.stringify({ ...rec, createdAt: rec.createdAt || Date.now() }));
}

export function deletePidFile(runtimeDir: string, qqId: string): void {
  const path = pidFilePath(runtimeDir, qqId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
