import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, posix } from "node:path";
import { glob } from "glob";
import { dataPath } from "@/utils/path";

export interface IMemoryStorage {
  read(path: string, offset: number, limit: number): Promise<string>;
  write(path: string, content: string, overwrite: boolean): Promise<string>;
  edit(path: string, oldString: string, newString: string): Promise<string>;
  delete(path: string, confirm: boolean): Promise<string>;
  glob(pattern: string, path: string | undefined, limit: number): Promise<string>;
  grep(pattern: string, path: string | undefined, include: string | undefined, ignoreCase: boolean): Promise<string>;
}

export async function createFsStorage(): Promise<IMemoryStorage> {
  const BASE_DIR = dataPath("workspace", "notepad");
  const MAX_LINE_LENGTH = 2000;
  const MAX_LINE_SUFFIX = "...";
  const MAX_MATCHES = 100;

  function getSafePath(path: string): string {
    const normalizedInput = posix.normalize(path).replace(/^\/+/, "");
    const fullPath = resolve(BASE_DIR, normalizedInput);
    const rel = relative(BASE_DIR, fullPath);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`非法路径：禁止目录穿越 (${path})`);
    }
    return fullPath;
  }

  function isWithinBaseDir(filePath: string): boolean {
    const rel = relative(BASE_DIR, filePath);
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  function getRelativePath(filePath: string): string {
    return "/" + posix.relative(BASE_DIR.replace(/\\/g, "/"), filePath.replace(/\\/g, "/"));
  }

  await mkdir(BASE_DIR, { recursive: true });

  async function read(path: string, offset: number, limit: number): Promise<string> {
    const fullPath = getSafePath(path);
    try {
      const s = await stat(fullPath);

      if (s.isDirectory()) {
        const entries = await readdir(fullPath, { withFileTypes: true });
        if (entries.length === 0) return `目录 "${path}" 为空。`;
        const items = entries.map((f) => (f.isDirectory() ? `${f.name}/` : f.name));
        const sliced = items.slice(offset, offset + limit);
        const truncated = offset + sliced.length < items.length;
        return [
          `<path>${path}</path>`,
          `<type>directory</type>`,
          `<entries>`,
          sliced.join("\n"),
          truncated
            ? `\n(结果截断：显示 ${sliced.length}/${items.length} 条，使用 offset 查看更多)`
            : `\n(${items.length} 条)`,
          `</entries>`,
        ].join("\n");
      }

      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      const sliced = lines.slice(offset, offset + limit);
      if (sliced.length === 0) return "文件为空或超出范围。";

      const linePrefix = sliced
        .map((line, i) => {
          const truncated = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line;
          return `${offset + i + 1}: ${truncated}`;
        })
        .join("\n");
      const endNote =
        offset + sliced.length >= lines.length
          ? `\n(文件结束 - 共 ${lines.length} 行)`
          : `\n(显示第 ${offset + 1}-${offset + sliced.length} 行，共 ${lines.length} 行)`;
      return [`<path>${path}</path>`, `<type>file</type>`, `<content>`, linePrefix + endNote, `</content>`].join("\n");
    } catch (e: any) {
      if (e.code === "ENOENT") return `错误：文件 "${path}" 不存在。`;
      throw e;
    }
  }

  async function write(path: string, content: string, overwrite: boolean): Promise<string> {
    const fullPath = getSafePath(path);
    const exists = await stat(fullPath)
      .then(() => true)
      .catch(() => false);
    if (exists && !overwrite) {
      return `错误：文件 "${path}" 已存在。若要覆写，请设置 overwrite=true。`;
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    return "文件写入成功。";
  }

  async function edit(path: string, oldString: string, newString: string): Promise<string> {
    const fullPath = getSafePath(path);
    try {
      const content = await readFile(fullPath, "utf-8");
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) return `错误：在 "${path}" 中未找到 old_string。`;
      if (occurrences > 1)
        return `错误：old_string 在 "${path}" 中匹配到 ${occurrences} 处，必须唯一。请提供更多上下文。`;

      const newContent = content.replace(oldString, newString);
      await writeFile(fullPath, newContent, "utf-8");
      return "编辑成功。";
    } catch (e: any) {
      if (e.code === "ENOENT") return `错误：文件 "${path}" 不存在。`;
      throw e;
    }
  }

  async function remove(path: string, confirm: boolean): Promise<string> {
    const fullPath = getSafePath(path);
    const stats = await stat(fullPath).catch(() => null);
    if (!stats) return `错误：文件 "${path}" 不存在。`;
    if (stats.isDirectory() && !confirm) {
      return `错误："${path}" 是目录，必须设置 confirm=true 才能删除。`;
    }
    await rm(fullPath, { recursive: true, force: true });
    return `已删除 "${path}"。`;
  }

  async function globFiles(pattern: string, searchPath: string | undefined, limit: number): Promise<string> {
    const searchDir = searchPath ? getSafePath(searchPath) : BASE_DIR;
    const files = await glob(pattern, { cwd: searchDir, nodir: true, absolute: true });

    const entries: { path: string; mtime: number }[] = [];
    for (const file of files) {
      if (!isWithinBaseDir(file)) continue;
      try {
        const s = await stat(file);
        entries.push({ path: getRelativePath(file), mtime: s.mtimeMs });
      } catch {}
    }

    entries.sort((a, b) => b.mtime - a.mtime);

    const truncated = entries.length > limit;
    const sliced = entries.slice(0, limit);

    if (sliced.length === 0) return "未找到匹配的文件。";

    const output = sliced.map((e) => e.path).join("\n");
    return output + (truncated ? `\n(结果截断：显示前 ${limit} 条)` : "");
  }

  async function grep(
    pattern: string,
    searchPath: string | undefined,
    include: string | undefined,
    ignoreCase: boolean,
  ): Promise<string> {
    const searchDir = searchPath ? getSafePath(searchPath) : BASE_DIR;
    const globPattern = include || "**/*";
    const files = await glob(globPattern, { cwd: searchDir, nodir: true, absolute: true });

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? "gi" : "g");
    } catch {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, ignoreCase ? "gi" : "g");
    }

    const fileMatches: { path: string; mtime: number; lines: { line: number; text: string }[] }[] = [];
    let totalCount = 0;

    for (const file of files) {
      if (totalCount >= MAX_MATCHES) break;
      if (!isWithinBaseDir(file)) continue;

      try {
        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");
        const matched: { line: number; text: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
          if (totalCount >= MAX_MATCHES) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i]!)) {
            let text = lines[i]!.trim();
            if (text.length > MAX_LINE_LENGTH) {
              text = text.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX;
            }
            matched.push({ line: i + 1, text });
            totalCount++;
          }
        }

        if (matched.length > 0) {
          const s = await stat(file);
          fileMatches.push({ path: getRelativePath(file), mtime: s.mtimeMs, lines: matched });
        }
      } catch {}
    }

    fileMatches.sort((a, b) => b.mtime - a.mtime);

    if (fileMatches.length === 0) return "未找到匹配的内容。";

    const output = [`找到 ${totalCount} 处匹配`];
    for (const fm of fileMatches) {
      output.push(`${fm.path}:`);
      for (const m of fm.lines) {
        output.push(`  第 ${m.line} 行: ${m.text}`);
      }
    }
    if (totalCount >= MAX_MATCHES) {
      output.push(`\n(结果截断：显示前 ${MAX_MATCHES} 条)`);
    }
    return output.join("\n");
  }

  return { read, write, edit, delete: remove, glob: globFiles, grep };
}
