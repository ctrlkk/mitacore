import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { type ChatHistory, migrateHistory } from "@/agents/chat-history";
import { dataPath } from "@/utils/path";
import { withHistoryMutation } from "./history-access";

type HistoryPaths = { planner: string; reply: string };
const defaultPaths: HistoryPaths = { planner: dataPath("planner.json"), reply: dataPath("chat.json") };

export class HistoryConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

async function readHistory(path: string): Promise<{ raw: string | undefined; records: ChatHistory }> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return { raw, records: [] };
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`历史文件格式不正确：${basename(path)}`);
  const records = migrateHistory(parsed);
  if (records.length !== parsed.length) throw new Error(`历史文件包含无法识别的记录：${basename(path)}`);
  return { raw, records };
}

function versionFor(planner: string | undefined, reply: string | undefined) {
  return createHash("sha256")
    .update(JSON.stringify([planner, reply]))
    .digest("hex");
}

function truncateHistory(history: ChatHistory, start: number): ChatHistory {
  return history.slice(0, start);
}

function lastRoundStart(history: ChatHistory): number {
  return history.findLastIndex((record) => record.user_turn !== undefined);
}

async function readPair(paths: HistoryPaths) {
  const [planner, reply] = await Promise.all([readHistory(paths.planner), readHistory(paths.reply)]);
  return { planner, reply, version: versionFor(planner.raw, reply.raw) };
}

type Round = {
  start: number;
  end: number;
  user_index: number;
  user_turn: number | undefined;
  timestamp: number;
  preview: string;
  reply_start: number | null;
  reply_end: number | null;
  can_rollback: boolean;
  reason?: string;
};

function buildRounds(planner: ChatHistory, reply: ChatHistory): Round[] {
  const plannerUsers = planner.flatMap((record, index) => (record.user_turn === undefined ? [] : [{ index, record }]));
  const replyUsers = reply.flatMap((record, index) => (record.user_turn === undefined ? [] : [{ index, record }]));
  const replyMatches = replyUsers.map(({ record }) => {
    const candidates = plannerUsers.filter(
      (entry) =>
        typeof entry.record.message.content === "string" &&
        entry.record.message.content === record.message.content &&
        entry.record.timestamp <= record.timestamp,
    );
    return candidates.length === 1 ? candidates[0]!.index : undefined;
  });
  const repliesOutOfOrder = replyMatches.some(
    (match, replyPosition) =>
      match !== undefined &&
      replyMatches.slice(replyPosition + 1).some((later) => later !== undefined && later < match),
  );

  return plannerUsers.map(({ index, record }, position) => {
    const start = startOfRound(planner, index);
    const nextUser = plannerUsers[position + 1]?.index;
    const end =
      nextUser === undefined
        ? planner.length
        : nextUser > 0 && planner[nextUser - 1]?.system_update
          ? nextUser - 1
          : nextUser;
    const matchedIndex = replyMatches.indexOf(index);
    const replyStart = matchedIndex < 0 ? null : startOfRound(reply, replyUsers[matchedIndex]!.index);
    const replyEnd =
      matchedIndex < 0
        ? null
        : replyUsers[matchedIndex + 1]
          ? startOfRound(reply, replyUsers[matchedIndex + 1]!.index)
          : reply.length;
    const ambiguous =
      repliesOutOfOrder ||
      replyUsers.some(
        (entry, replyPosition) =>
          entry.record.timestamp >= record.timestamp && replyMatches[replyPosition] === undefined,
      );
    const compressed = reply.some((entry) => entry.summary && entry.timestamp >= record.timestamp);
    const preview = typeof record.message.content === "string" ? record.message.content : "[结构化用户消息]";
    return {
      start,
      end,
      user_index: index,
      user_turn: record.user_turn,
      timestamp: record.timestamp,
      preview,
      reply_start: replyStart,
      reply_end: replyEnd,
      can_rollback: !ambiguous && !compressed,
      reason: compressed ? "回复历史已压缩，无法安全回退到此轮" : ambiguous ? "两层历史无法安全对应" : undefined,
    };
  });
}

function startOfRound(history: ChatHistory, userIndex: number) {
  return userIndex > 0 && history[userIndex - 1]?.system_update ? userIndex - 1 : userIndex;
}

export async function getConversationHistory(paths: HistoryPaths = defaultPaths) {
  const pair = await readPair(paths);
  return {
    version: pair.version,
    planner: pair.planner.records,
    reply: pair.reply.records,
    rounds: buildRounds(pair.planner.records, pair.reply.records),
  };
}

async function writePair(
  paths: HistoryPaths,
  pair: Awaited<ReturnType<typeof readPair>>,
  planner: ChatHistory,
  reply: ChatHistory,
) {
  const plannerTemp = `${paths.planner}.${randomUUID()}.tmp`;
  const replyTemp = `${paths.reply}.${randomUUID()}.tmp`;
  await mkdir(dirname(paths.planner), { recursive: true });
  await mkdir(dirname(paths.reply), { recursive: true });
  try {
    await writeFile(plannerTemp, JSON.stringify(planner, null, 2));
    await writeFile(replyTemp, JSON.stringify(reply, null, 2));
    await rename(plannerTemp, paths.planner);
    try {
      await rename(replyTemp, paths.reply);
    } catch (error) {
      // 双文件无法原子提交；第二次替换失败时尽力恢复第一份原始历史。
      if (pair.planner.raw === undefined) await rm(paths.planner, { force: true });
      else await writeFile(paths.planner, pair.planner.raw);
      throw error;
    }
  } finally {
    await Promise.all([rm(plannerTemp, { force: true }), rm(replyTemp, { force: true })]);
  }
}

export async function rollbackConversation(userIndex: number, version: string, paths: HistoryPaths = defaultPaths) {
  return withHistoryMutation(async () => {
    const pair = await readPair(paths);
    if (pair.version !== version) throw new HistoryConflictError("历史已发生变化，请刷新后重试");
    const rounds = buildRounds(pair.planner.records, pair.reply.records);
    const round = rounds.find((item) => item.user_index === userIndex);
    if (!round) throw new HistoryConflictError("该轮对话已不存在，请刷新后重试");
    if (!round.can_rollback) throw new HistoryConflictError(round.reason ?? "无法安全回退该轮对话");
    const followingReply = rounds
      .filter((item) => item.user_index >= userIndex && item.reply_start !== null)
      .map((item) => item.reply_start!);
    const replyStart = followingReply.length ? Math.min(...followingReply) : pair.reply.records.length;
    await writePair(
      paths,
      pair,
      truncateHistory(pair.planner.records, round.start),
      truncateHistory(pair.reply.records, replyStart),
    );
    return {
      removed_planner: pair.planner.records.length - round.start,
      removed_reply: pair.reply.records.length - replyStart,
    };
  });
}

export async function clearConversation(version: string, paths: HistoryPaths = defaultPaths) {
  return withHistoryMutation(async () => {
    const pair = await readPair(paths);
    if (pair.version !== version) throw new HistoryConflictError("历史已发生变化，请刷新后重试");
    await writePair(paths, pair, [], []);
    return { removed_planner: pair.planner.records.length, removed_reply: pair.reply.records.length };
  });
}

export async function undoLastConversation(processing: boolean, paths: HistoryPaths = defaultPaths) {
  if (processing) return "当前正在处理消息，暂时无法撤回。";
  return withHistoryMutation(async () => {
    const pair = await readPair(paths);
    const plannerStart = lastRoundStart(pair.planner.records);
    if (plannerStart < 0) return "没有可撤回的上一轮消息。";
    const replyStart = lastRoundStart(pair.reply.records);
    await writePair(
      paths,
      pair,
      truncateHistory(pair.planner.records, plannerStart),
      truncateHistory(pair.reply.records, replyStart < 0 ? pair.reply.records.length : replyStart),
    );
    return "已撤回上一轮消息。";
  });
}
