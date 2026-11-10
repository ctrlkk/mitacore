import { constants, createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { dataPath, projectPath } from "@/utils/path";

const VERSION_MARKER = ".default-data-version";

async function migrateLegacyRole() {
  const sourcePath = projectPath("prompts", "role.txt");
  const targetPath = dataPath("prompts", "role.txt");
  if (existsSync(targetPath)) return;

  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    // 保留旧文件供回退版本使用；排他复制也避免并发启动覆盖已创建的用户角色。
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") throw error;
  }
}

function getArchivePath() {
  return projectPath("references", "default-data.zip");
}

function getManifestPath() {
  return projectPath("references", "default-data", "manifest.json");
}

async function readDefaultDataVersion() {
  const manifest = JSON.parse(await readFile(getManifestPath(), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "number" || !Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error("默认数据版本无效");
  }
  return String(manifest.version);
}

function resolveArchiveEntry(targetDir: string, entryName: string) {
  const normalized = entryName.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || /^[a-zA-Z]:/.test(segment))
  ) {
    throw new Error(`默认数据包含非法路径: ${entryName}`);
  }

  const targetPath = resolve(targetDir, ...segments);
  const targetRelativePath = relative(targetDir, targetPath);
  if (targetRelativePath.startsWith("..") || /^[\\/]/.test(targetRelativePath)) {
    throw new Error(`默认数据路径越界: ${entryName}`);
  }
  return targetPath;
}

async function extractArchive(archivePath: string, targetDir: string) {
  const writers: Promise<void>[] = [];
  let extractionError: Error | undefined;
  const unzipper = new Unzip((file) => {
    const targetPath = resolveArchiveEntry(targetDir, file.name);
    if (file.name.endsWith("/")) {
      mkdirSync(targetPath, { recursive: true });
      file.ondata = () => {};
      file.start();
      return;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    const writer = createWriteStream(targetPath, { flags: "wx" });
    writers.push(
      new Promise((resolveWriter, rejectWriter) => {
        writer.once("finish", resolveWriter);
        writer.once("error", rejectWriter);
      }),
    );
    file.ondata = (error, data, final) => {
      if (error) {
        extractionError = error;
        writer.destroy(error);
        return;
      }
      if (data.byteLength > 0) writer.write(data);
      if (final) writer.end();
    };
    file.start();
  });
  unzipper.register(UnzipInflate);

  for await (const chunk of createReadStream(archivePath)) {
    unzipper.push(chunk as Uint8Array, false);
  }
  unzipper.push(new Uint8Array(0), true);
  await Promise.all(writers);
  if (extractionError) throw extractionError;
}

async function copyMissingFiles(sourceDir: string, targetDir: string) {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyMissingFiles(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) continue;

    mkdirSync(dirname(targetPath), { recursive: true });
    try {
      // COPYFILE_EXCL 让并发启动时也不会覆盖已创建的用户文件。
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * 按版本补充缺失的内置默认数据。所有内容先解压至临时目录，再以排他创建方式写入 data，
 * 因而不会覆盖用户文件，解压失败也不会留下半成品默认数据。
 */
export async function initializeDefaultData() {
  // 必须先迁移用户角色，避免默认模板占用目标路径；迁移不依赖默认数据包或版本标记。
  await migrateLegacyRole();

  const archivePath = getArchivePath();
  if (!existsSync(archivePath)) return;

  const version = await readDefaultDataVersion();
  const markerPath = dataPath(VERSION_MARKER);
  const installedVersion = await readFile(markerPath, "utf8").catch(() => "");
  if (installedVersion.trim() === version) return;

  const tempDir = dataPath(`.${VERSION_MARKER}-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dataPath(), { recursive: true });
    await rm(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    await extractArchive(archivePath, tempDir);
    await copyMissingFiles(tempDir, dataPath());
    await writeFile(markerPath, `${version}\n`);
    console.info(`已初始化默认数据（版本 ${version}）`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
