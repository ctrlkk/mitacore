import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { findExecutable } from "./find-executable";

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("findExecutable (Windows)", () => {
  test("跳过 PATH 中的 cmd shim 并继续查找原生可执行文件", async () => {
    const shimDirectory = await mkdtemp(join(tmpdir(), "find-executable-shim-"));
    const executableDirectory = await mkdtemp(join(tmpdir(), "find-executable-exe-"));
    temporaryDirectories.push(shimDirectory, executableDirectory);

    const name = "find-executable-test-tool";
    await writeFile(join(shimDirectory, `${name}.cmd`), "@exit /b 0\r\n");
    const executable = join(executableDirectory, `${name}.exe`);
    await copyFile(process.execPath, executable);
    process.env.PATH = [shimDirectory, executableDirectory].join(delimiter);

    expect(findExecutable(name)).toBe(executable);
  });

  test("只有 cmd shim 时返回 null", async () => {
    const shimDirectory = await mkdtemp(join(tmpdir(), "find-executable-shim-"));
    temporaryDirectories.push(shimDirectory);

    const name = "find-executable-test-tool";
    await writeFile(join(shimDirectory, `${name}.cmd`), "@exit /b 0\r\n");
    process.env.PATH = shimDirectory;

    expect(findExecutable(name)).toBeNull();
  });
});
