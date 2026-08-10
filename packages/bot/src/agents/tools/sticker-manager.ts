import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, parse } from "node:path";
import { Mutex } from "async-mutex";

const stickerExtensions = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif"]);
const stickerNamePattern = /^[\p{L}][\p{L}\p{N}_-]+$/u;
const stickerLocks = new Map<string, Mutex>();

type StickerManagerOptions = {
  stickersDir: string;
  imageCacheDir: string;
  maxStickers: number;
};

export function createStickerManager(options: StickerManagerOptions) {
  const lock =
    stickerLocks.get(options.stickersDir) ??
    (() => {
      const created = new Mutex();
      stickerLocks.set(options.stickersDir, created);
      return created;
    })();

  async function getStickerFiles() {
    const files = await readdir(options.stickersDir).catch(() => []);
    return files.filter((file) => stickerExtensions.has(parse(file).ext.toLowerCase()));
  }

  async function list() {
    const files = await getStickerFiles();
    const names = files.map((file) => parse(file).name).sort((a, b) => a.localeCompare(b));
    return `当前有 ${files.length}/${options.maxStickers} 张贴纸：${names.length > 0 ? names.join("、") : "暂无"}`;
  }

  async function add(sourcePath: string, name: string, description: string) {
    return await lock.runExclusive(async () => {
      if (!stickerNamePattern.test(name)) {
        return "添加失败：贴纸名必须以字母或汉字开头，且只能包含字母、汉字、数字、下划线和连字符，至少 2 个字符。";
      }

      const sourceFile = basename(sourcePath);
      const extension = parse(sourceFile).ext.toLowerCase();
      if (!stickerExtensions.has(extension)) {
        return "添加失败：仅支持 webp、png、jpg、jpeg 和 gif 图片。";
      }
      if (!description.trim()) return "添加失败：贴纸描述不能为空。";

      const source = join(options.imageCacheDir, sourceFile);
      const sourceStat = await stat(source).catch(() => null);
      if (!sourceStat?.isFile()) return `添加失败：图片文件未找到：${sourcePath}，图片或路径可能不存在。`;

      await mkdir(options.stickersDir, { recursive: true });
      const files = await getStickerFiles();
      if (files.some((file) => parse(file).name === name)) return `添加失败：已存在名为「${name}」的贴纸。`;
      if (files.length >= options.maxStickers) {
        return `添加失败：贴纸数量已达到上限 ${options.maxStickers}，请先移除不常用的贴纸。`;
      }

      const targetFile = `${name}${extension}`;
      const target = join(options.stickersDir, targetFile);
      let copied = false;
      try {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        copied = true;
        await writeFile(join(options.stickersDir, `${targetFile}.txt`), description.trim(), {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        if (copied) await rm(target, { force: true }).catch(() => undefined);
        return `添加失败：${error instanceof Error ? error.message : String(error)}`;
      }

      return `已添加贴纸「${name}」，当前有 ${files.length + 1}/${options.maxStickers} 张贴纸。`;
    });
  }

  async function remove(name: string) {
    return await lock.runExclusive(async () => {
      const files = await getStickerFiles();
      const matches = files.filter((file) => parse(file).name === name);
      if (matches.length === 0) return `移除失败：不存在名为「${name}」的贴纸。`;

      await Promise.all(
        matches.flatMap((file) => [
          rm(join(options.stickersDir, file), { force: true }),
          rm(join(options.stickersDir, `${file}.txt`), { force: true }),
        ]),
      );
      return `已移除贴纸「${name}」，当前有 ${files.length - matches.length}/${options.maxStickers} 张贴纸。`;
    });
  }

  return { list, add, remove };
}
