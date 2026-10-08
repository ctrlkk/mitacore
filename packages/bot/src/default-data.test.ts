import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const install = vi.hoisted(() => ({ root: "" }));

vi.mock("@/utils/path", async () => {
  const { resolve } = await import("node:path");
  return {
    projectPath: (...segments: string[]) => resolve(install.root, ...segments),
    dataPath: (...segments: string[]) => resolve(install.root, "data", ...segments),
  };
});

import { initializeDefaultData } from "./default-data";

const tempRoot = resolve(tmpdir(), "opencode");

function projectPath(...segments: string[]) {
  return resolve(install.root, ...segments);
}

function dataPath(...segments: string[]) {
  return projectPath("data", ...segments);
}

async function writeProjectFile(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeArchive(version: number, files: Record<string, string> = { "prompts/role.txt": "新版默认角色" }) {
  await writeProjectFile(projectPath("references", "default-data", "manifest.json"), JSON.stringify({ version }));
  await writeFile(
    projectPath("references", "default-data.zip"),
    zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))),
  );
}

async function readDataFile(...segments: string[]) {
  return readFile(dataPath(...segments), "utf8");
}

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true });
  install.root = await mkdtemp(resolve(tempRoot, "default-data-test-"));
});

afterEach(async () => {
  await rm(install.root, { recursive: true, force: true });
  install.root = "";
});

describe("initializeDefaultData 角色迁移", () => {
  test("没有旧版角色时首次启动写入 ZIP 中的默认角色和其他数据", async () => {
    await writeArchive(2, { "prompts/role.txt": "新版默认角色", "settings/example.txt": "默认设置" });

    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("新版默认角色");
    expect(await readDataFile("settings", "example.txt")).toBe("默认设置");
    expect(await readDataFile(".default-data-version")).toBe("2\n");
  });

  test("首次启动从旧版角色写入数据目录，并保留安装目录中的原文件", async () => {
    await writeProjectFile(projectPath("prompts", "role.txt"), "旧版自定义角色");
    await writeArchive(2, { "prompts/role.txt": "新版默认角色", "settings/example.txt": "默认设置" });

    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("旧版自定义角色");
    expect(await readFile(projectPath("prompts", "role.txt"), "utf8")).toBe("旧版自定义角色");
    expect(await readDataFile("settings", "example.txt")).toBe("默认设置");
    expect(await readDataFile(".default-data-version")).toBe("2\n");
  });

  test("已有新版自定义角色时优先保留新版，并保留旧版原文件", async () => {
    await writeProjectFile(projectPath("prompts", "role.txt"), "旧版角色");
    await writeProjectFile(dataPath("prompts", "role.txt"), "新版自定义角色");
    await writeArchive(2);

    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("新版自定义角色");
    expect(await readFile(projectPath("prompts", "role.txt"), "utf8")).toBe("旧版角色");
    expect(await readDataFile(".default-data-version")).toBe("2\n");
  });

  test("空的旧版角色也视为用户文件，不被 ZIP 中的默认角色替换", async () => {
    await writeProjectFile(projectPath("prompts", "role.txt"), "");
    await writeArchive(2);

    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("");
    expect(await readFile(projectPath("prompts", "role.txt"), "utf8")).toBe("");
  });

  test("重复启动及升级时不覆盖已写入的角色和其他用户数据", async () => {
    await writeProjectFile(projectPath("prompts", "role.txt"), "旧版角色");
    await writeArchive(1, { "prompts/role.txt": "默认角色 v1", "settings/example.txt": "默认设置 v1" });
    await initializeDefaultData();
    await writeFile(dataPath("prompts", "role.txt"), "用户更新后的角色");
    await writeFile(dataPath("settings", "example.txt"), "用户更新后的设置");

    await initializeDefaultData();
    await writeArchive(2, {
      "prompts/role.txt": "默认角色 v2",
      "settings/example.txt": "默认设置 v2",
      "settings/new.txt": "新增默认设置",
    });
    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("用户更新后的角色");
    expect(await readDataFile("settings", "example.txt")).toBe("用户更新后的设置");
    expect(await readDataFile("settings", "new.txt")).toBe("新增默认设置");
    expect(await readFile(projectPath("prompts", "role.txt"), "utf8")).toBe("旧版角色");
    expect(await readDataFile(".default-data-version")).toBe("2\n");
  });

  test("没有 ZIP 时仍迁移旧版角色", async () => {
    await writeProjectFile(projectPath("prompts", "role.txt"), "无 ZIP 的旧版角色");

    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("无 ZIP 的旧版角色");
    expect(await readFile(projectPath("prompts", "role.txt"), "utf8")).toBe("无 ZIP 的旧版角色");
    await expect(readDataFile(".default-data-version")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("版本号已匹配时仍迁移旧版角色", async () => {
    await writeProjectFile(projectPath("prompts", "role.txt"), "迟到的旧版角色");
    await writeProjectFile(dataPath(".default-data-version"), "2\n");
    await writeArchive(2);

    await initializeDefaultData();

    expect(await readDataFile("prompts", "role.txt")).toBe("迟到的旧版角色");
    expect(await readFile(projectPath("prompts", "role.txt"), "utf8")).toBe("迟到的旧版角色");
    expect(await readDataFile(".default-data-version")).toBe("2\n");
  });

  test("旧版角色读取失败时中止初始化，不填入默认角色且不更新版本号", async () => {
    await mkdir(projectPath("prompts", "role.txt"), { recursive: true });
    await writeProjectFile(dataPath(".default-data-version"), "1\n");
    await writeArchive(2, { "prompts/role.txt": "默认角色", "settings/example.txt": "默认设置" });

    await expect(initializeDefaultData()).rejects.toThrow();

    await expect(readDataFile("prompts", "role.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readDataFile("settings", "example.txt")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readDataFile(".default-data-version")).toBe("1\n");
  });
});
