import { describe, expect, test } from "vitest";
import { spawn } from "./spawn";

describe("spawn", () => {
  test("写入 stdin 并收集 stdout", async () => {
    const result = await spawn(
      process.execPath,
      ["-e", 'process.stdin.on("data", chunk => process.stdout.write(chunk))'],
      { stdin: "hello" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.toString()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("非零退出时保留 stderr", async () => {
    const result = await spawn(process.execPath, ["-e", 'process.stderr.write("failed"); process.exit(2)']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("failed");
  });

  test("启动失败时抛出异常", async () => {
    await expect(spawn("executable-that-does-not-exist-8d45013a", [])).rejects.toThrow();
  });

  test("并发消费大量 stderr 且不让 EPIPE 覆盖非零退出", async () => {
    const result = await spawn(
      process.execPath,
      ["-e", 'process.stderr.write("x".repeat(1024 * 1024)); process.exit(3)'],
      { stdin: new Blob([new Uint8Array(4 * 1024 * 1024)]) },
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr.length).toBe(1024 * 1024);
  });
});
