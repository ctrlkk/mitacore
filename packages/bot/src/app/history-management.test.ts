import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatHistory } from "@/agents/chat-history";
import { HistoryBusyError, withHistoryRun } from "./history-access";
import {
  clearConversation,
  getConversationHistory,
  HistoryConflictError,
  rollbackConversation,
  undoLastConversation,
} from "./history-management";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(planner: ChatHistory, reply: ChatHistory) {
  const directory = await mkdtemp(join(tmpdir(), "bot-history-"));
  directories.push(directory);
  const paths = { planner: join(directory, "planner.json"), reply: join(directory, "chat.json") };
  await Promise.all([writeFile(paths.planner, JSON.stringify(planner)), writeFile(paths.reply, JSON.stringify(reply))]);
  return paths;
}

const user = (content: string, timestamp: number, turn: number): ChatHistory[number] => ({
  message: { role: "user", content },
  timestamp,
  user_turn: turn,
});
const assistant = (content: string, timestamp: number): ChatHistory[number] => ({
  message: { role: "assistant", content },
  timestamp,
});

describe("双层历史回退", () => {
  it("从选中轮起截断两层，保留此前记录和元数据", async () => {
    const planner: ChatHistory = [
      user("第一轮", 100, 1),
      assistant("计划一", 110),
      {
        message: { role: "user", content: "<system_update>更新</system_update>" },
        timestamp: 200,
        system_update: { current_date: "今天" },
      },
      user("第二轮", 200, 2),
      assistant("计划二", 210),
      user("第三轮", 300, 3),
      assistant("计划三", 310),
    ];
    const reply: ChatHistory = [
      user("第一轮", 105, 1),
      assistant("回复一", 115),
      { message: { role: "user", content: "更新" }, timestamp: 305, system_update: { current_date: "明天" } },
      user("第三轮", 305, 2),
      assistant("回复三", 315),
    ];
    const paths = await fixture(planner, reply);
    const snapshot = await getConversationHistory(paths);

    expect(snapshot.rounds.map((round) => round.user_index)).toEqual([0, 3, 5]);
    expect(snapshot.rounds[1]?.start).toBe(2);
    expect(snapshot.rounds[1]?.can_rollback).toBe(true);
    await expect(rollbackConversation(3, snapshot.version, paths)).resolves.toEqual({
      removed_planner: 5,
      removed_reply: 3,
    });
    expect(JSON.parse(await readFile(paths.planner, "utf8"))).toEqual(planner.slice(0, 2));
    expect(JSON.parse(await readFile(paths.reply, "utf8"))).toEqual(reply.slice(0, 2));
  });

  it("拒绝版本过期及无法对应的回复历史", async () => {
    const paths = await fixture([user("重复", 100, 1), user("重复", 200, 2)], [user("重复", 205, 1)]);
    const snapshot = await getConversationHistory(paths);
    expect(snapshot.rounds[0]?.can_rollback).toBe(false);
    await expect(rollbackConversation(0, snapshot.version, paths)).rejects.toBeInstanceOf(HistoryConflictError);
    await writeFile(paths.planner, JSON.stringify([user("更改", 100, 1)]));
    await expect(clearConversation(snapshot.version, paths)).rejects.toBeInstanceOf(HistoryConflictError);
  });

  it("摘要包含选中轮时阻止回退，但允许清空两层", async () => {
    const paths = await fixture(
      [user("第一轮", 100, 1)],
      [{ ...assistant("摘要", 200), summary: true }, user("第一轮", 210, 1)],
    );
    const snapshot = await getConversationHistory(paths);
    expect(snapshot.rounds[0]?.can_rollback).toBe(false);
    await expect(rollbackConversation(0, snapshot.version, paths)).rejects.toBeInstanceOf(HistoryConflictError);
    await clearConversation(snapshot.version, paths);
    expect(JSON.parse(await readFile(paths.planner, "utf8"))).toEqual([]);
    expect(JSON.parse(await readFile(paths.reply, "utf8"))).toEqual([]);
  });

  it("agent 正在使用历史时拒绝修改", async () => {
    const paths = await fixture([user("第一轮", 100, 1)], []);
    const { version } = await getConversationHistory(paths);
    let finish!: () => void;
    const running = withHistoryRun(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(clearConversation(version, paths)).rejects.toBeInstanceOf(HistoryBusyError);
    finish();
    await running;
  });

  it("/undo 沿用最后一个 user_turn 的截断行为", async () => {
    const paths = await fixture(
      [user("第一轮", 100, 1), assistant("计划一", 110), user("第二轮", 200, 2)],
      [user("第一轮", 105, 1), assistant("回复一", 115), user("第二轮", 205, 2), assistant("回复二", 215)],
    );
    expect(await undoLastConversation(false, paths)).toBe("已撤回上一轮消息。");
    expect((await getConversationHistory(paths)).rounds).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.reply, "utf8"))).toHaveLength(2);
  });

  it("拒绝覆盖格式错误的历史文件", async () => {
    const paths = await fixture([user("第一轮", 100, 1)], []);
    await writeFile(paths.reply, JSON.stringify({ unexpected: true }));
    await expect(getConversationHistory(paths)).rejects.toThrow("历史文件格式不正确");
    expect(JSON.parse(await readFile(paths.planner, "utf8"))).toHaveLength(1);
  });
});
