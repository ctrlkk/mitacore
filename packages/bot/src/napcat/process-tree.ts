/**
 * 跨平台进程树工具
 *
 * 设计目标：替代 psutil.Process(pid).children(recursive=True) 风格的进程树枚举与杀除，
 * 由于不引入 psutil 依赖，使用平台 CLI 一次性建图 + 本地 BFS 递归。
 *
 * - Windows: `Get-CimInstance Win32_Process` 一次性拿全系统 pid/ppid/comm，
 *   ~150ms 完成；用 taskkill 杀进程 + tasklist 验证存在。
 * - POSIX:   `ps -eo pid,ppid,comm` 一次性拿全系统 pid/ppid/comm，
 *   用 kill 杀进程 + kill(pid, 0) 验证存在。
 *
 * 杀序：深度优先叶子 → 根，避免父先死导致子被 init 接管。
 * awaitExit：每个 kill 后轮询确认 OS 进程真退，5s 超时兜底。
 */
import { execSync, execFileSync } from "node:child_process";
import { logger } from "@/logger";

const IS_WIN = process.platform === "win32";

/** 单次 kill 后的等待超时（与 vendor 桌面版对齐） */
const AWAIT_EXIT_TIMEOUT_MS = 5000;
/** 轮询间隔 */
const AWAIT_EXIT_POLL_MS = 100;

/** 进程图：parent → children + pid → comm */
export interface PidGraph {
  children: Map<number, number[]>;
  names: Map<number, string>;
}

/**
 * Windows: Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
 * 输出 CSV, 解析建图。
 */
function buildPidGraphWindows(): PidGraph {
  const cmd =
    "powershell -NoProfile -NonInteractive -Command " +
    '"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"';
  const raw = execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  return parseWindowsCsv(raw);
}

/** 解析 PowerShell ConvertTo-Csv 输出。首行是表头，跳过。 */
function parseWindowsCsv(csv: string): PidGraph {
  const children = new Map<number, number[]>();
  const names = new Map<number, string>();
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // CSV: "1234","5678","name.exe"
    // 简单解析：去掉首尾引号，按 "," 切（comm 可能含逗号但 PS 会转义为 ""）
    const cells = splitCsvLine(line);
    if (cells.length < 3) continue;
    const pid = Number.parseInt(cells[0]!, 10);
    const ppid = Number.parseInt(cells[1]!, 10);
    const name = cells[2]!;
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    names.set(pid, name);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  return { children, names };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * POSIX: ps -eo pid,ppid,comm
 * comm 是短进程名（不含路径与参数），用于白名单校验足够。
 */
function buildPidGraphPosix(): PidGraph {
  const raw = execSync("ps -eo pid=,ppid=,comm=", { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  const children = new Map<number, number[]>();
  const names = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0]!, 10);
    const ppid = Number.parseInt(parts[1]!, 10);
    const comm = parts[2]!;
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    names.set(pid, comm);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  return { children, names };
}

export const buildPidGraph: () => PidGraph = IS_WIN ? buildPidGraphWindows : buildPidGraphPosix;

/**
 * 广度优先遍历 root 的所有后代（不含 root 自身）。
 * 用于杀除前枚举目标 PID 子树。
 */
export function descendantsOf(graph: PidGraph, root: number): number[] {
  const out: number[] = [];
  const queue: number[] = [...(graph.children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = graph.children.get(pid);
    if (kids) queue.push(...kids);
  }
  return out;
}

/** launcher 进程名白名单（精确校验用） */
const LAUNCHER_NAMES_WIN = new Set(["NapCatWinBootMain.exe", "QQ.exe", "qq.exe"]);
const LAUNCHER_NAMES_POSIX = new Set(["qq", "QQ", "xvfb-run", "Xvfb", "node"]);

/** 校验 PID 是否仍存活且是允许的 launcher 进程名。 */
export function isLauncherAlive(graph: PidGraph, pid: number): boolean {
  const name = graph.names.get(pid);
  if (!name) return false;
  const allow = IS_WIN ? LAUNCHER_NAMES_WIN : LAUNCHER_NAMES_POSIX;
  return allow.has(name);
}

/** 单点验证进程是否存活（无需建图，用于 awaitExit 轮询） */
export function isPidAlive(pid: number): boolean {
  if (IS_WIN) {
    try {
      const out = execFileSync("tasklist", ["/NH", "/FI", `PID eq ${pid}`, "/FO", "CSV"], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // 存在: "QQ.exe","1234",...; 不存在: "INFO: No tasks are running which match the specified criteria."
      return !out.includes("INFO:") && out.includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Windows: 杀单点（带 /T 兜底传子） */
function killPidWindows(pid: number, force: boolean): void {
  const flag = force ? "/F" : "";
  try {
    execFileSync("taskkill", ["/T", "/PID", String(pid), flag].filter(Boolean), {
      timeout: 3000,
      stdio: "ignore",
    });
  } catch {}
}

/** POSIX: 杀单点（TERM/KILL） */
function killPidPosix(pid: number, force: boolean): void {
  const sig = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, sig);
  } catch {}
}

const killPid: (pid: number, force: boolean) => void = IS_WIN ? killPidWindows : killPidPosix;

/**
 * 杀进程后等待其真退；返回 true 表示在超时内已退，false 表示超时。
 * 实现：每 100ms 调 isPidAlive 轮询。
 */
export async function awaitExit(pid: number, timeoutMs = AWAIT_EXIT_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(AWAIT_EXIT_POLL_MS);
  }
  return !isPidAlive(pid);
}

/**
 * 杀进程树：先子后父（BFS 倒序近似 DFS 叶子），每个 kill 内部 awaitExit。
 *
 * @param rootPid 根进程 PID（必须存活或最近刚死）
 * @param opts.timeoutMs 单点等待超时
 * @param opts.skipMissing 根进程若不存在是否直接返回（默认 true：避免重复杀）
 */
export async function killTree(
  rootPid: number,
  opts: { timeoutMs?: number; skipMissing?: boolean } = {},
): Promise<void> {
  const { timeoutMs = AWAIT_EXIT_TIMEOUT_MS, skipMissing = true } = opts;
  const graph = buildPidGraph();
  if (!graph.names.has(rootPid)) {
    if (skipMissing) return;
  }
  const descendants = descendantsOf(graph, rootPid);
  // 倒序：近似先杀叶子。同一层内不保证严格顺序，但 BFS 倒序对单链树是叶子→根。
  for (const pid of descendants.reverse()) {
    killPid(pid, false);
  }
  // 等所有子都退
  for (const pid of descendants) {
    await awaitExit(pid, timeoutMs);
    if (isPidAlive(pid)) {
      killPid(pid, true);
      await awaitExit(pid, timeoutMs);
    }
  }
  // 根
  killPid(rootPid, false);
  await awaitExit(rootPid, timeoutMs);
  if (isPidAlive(rootPid)) {
    killPid(rootPid, true);
    await awaitExit(rootPid, timeoutMs);
  }
}

/**
 * 查指定端口的占用 PID。
 * Windows: netstat -ano -p TCP | findstr :PORT  → 解析 LISTENING 行末尾的 PID
 * POSIX:   lsof -iTCP:PORT -sTCP:LISTEN -t      → 直接吐 PID
 *
 * 失败返回 0。
 */
export function pidListeningOn(port: number): number {
  if (IS_WIN) {
    try {
      const out = execSync(`netstat -ano -p TCP | findstr :${port}`, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const m = line.match(/\s(\d+)\s*$/);
        if (m) {
          const pid = Number.parseInt(m[1]!, 10);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
    } catch {}
    return 0;
  }
  try {
    const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.trim().split("\n")[0]?.trim();
    const pid = Number.parseInt(first ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * 杀端口占用进程：先反查 PID，校验为允许的名称后 killTree。
 * expectedNames 是白名单（QQ.exe / node.exe / NapCatWinBootMain.exe 等），
 * 校验失败时拒绝杀（避免误杀用户其他程序）。
 */
export async function killProcessOnPort(port: number, expectedNames: string[]): Promise<void> {
  const pid = pidListeningOn(port);
  if (pid <= 0) return;
  const graph = buildPidGraph();
  const name = graph.names.get(pid);
  if (!name || !expectedNames.includes(name)) {
    logger.warn({ port, pid, name, expected: expectedNames }, "端口占用进程名不匹配，跳过强杀");
    return;
  }
  logger.info({ port, pid, name }, "端口被占用，强杀占进程");
  await killTree(pid);
}
