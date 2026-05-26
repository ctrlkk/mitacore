import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, normalize } from 'node:path';
import { glob } from 'glob';
import XMLBuilder from "fast-xml-builder";

export interface IMemoryStorage {
  read(path: string, offset: number, limit: number): Promise<string>;
  write(path: string, content: string, overwrite: boolean): Promise<string>;
  edit(path: string, oldString: string, newString: string): Promise<string>;
  delete(path: string, confirm: boolean): Promise<string>;
  search(query: string, limit: number): Promise<string>;
  list(path: string): Promise<string>;
  glob(pattern: string, limit: number): Promise<string>;
  grep(pattern: string, path: string | undefined, ignoreCase: boolean): Promise<string>;
}

const BASE_DIR = resolve(process.cwd(), '.cache/memory');

// 保留你的 XML 构造器，并显式声明属性与文本节点的解析规则
const builder = new XMLBuilder({
  format: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

export class FsMemoryStorage implements IMemoryStorage {
  constructor() {
    mkdir(BASE_DIR, { recursive: true }).catch(() => {});
  }

  private getSafePath(path: string): string {
    const normalized = normalize(path).replace(/\\/g, '/');
    const fullPath = resolve(BASE_DIR, normalized.replace(/^\/+/, ''));
    if (!fullPath.startsWith(BASE_DIR)) {
      throw new Error('非法路径：禁止目录穿越');
    }
    return fullPath;
  }

  // 📖 结构化返回：带行号的文件内容
  async read(path: string, offset: number, limit: number): Promise<string> {
    const fullPath = this.getSafePath(path);
    try {
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const sliced = lines.slice(offset, offset + limit);
      if (sliced.length === 0) return '文件为空或超出范围。';
      
      const textContent = sliced.map((line, i) => `[${offset + i + 1}] ${line}`).join('\n');
      return builder.build({
        file: {
          '@_path': path,
          '@_total_lines': lines.length,
          '#text': textContent
        }
      });
    } catch (e: any) {
      if (e.code === 'ENOENT') return `错误：节点 "${path}" 不存在。`;
      throw e;
    }
  }

  // 💬 口语化返回：操作结果
  async write(path: string, content: string, overwrite: boolean): Promise<string> {
    const fullPath = this.getSafePath(path);
    const exists = await stat(fullPath).then(() => true).catch(() => false);
    if (exists && !overwrite) {
      return `错误：节点 "${path}" 已存在。若要覆写，请显式设置 overwrite=true。`;
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    return `成功${overwrite && exists ? '覆写' : '创建'}记忆节点：${path}`;
  }

  // 💬 口语化返回：操作结果
  async edit(path: string, oldString: string, newString: string): Promise<string> {
    const fullPath = this.getSafePath(path);
    try {
      const content = await readFile(fullPath, 'utf-8');
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) return `错误：在 "${path}" 中未找到精确匹配的 old_string。`;
      if (occurrences > 1) return `错误：old_string 匹配到了 ${occurrences} 处，必须保证唯一性。请提供更多上下文。`;
      
      const newContent = content.replace(oldString, newString);
      await writeFile(fullPath, newContent, 'utf-8');
      return `成功精确更新记忆 "${path}"。`;
    } catch (e: any) {
      if (e.code === 'ENOENT') return `错误：节点 "${path}" 不存在。`;
      throw e;
    }
  }

  // 💬 口语化返回：操作结果
  async delete(path: string, confirm: boolean): Promise<string> {
    const fullPath = this.getSafePath(path);
    const stats = await stat(fullPath).catch(() => null);
    if (!stats) return `错误：节点 "${path}" 不存在。`;
    if (stats.isDirectory() && !confirm) {
      return `错误："${path}" 是一个目录，必须设置 confirm=true 才能级联删除。`;
    }
    await rm(fullPath, { recursive: true, force: true });
    return `已成功删除节点 "${path}" 及其所有子内容。`;
  }

  // 📖 结构化返回：语义/全文搜索结果列表
  async search(query: string, limit: number): Promise<string> {
    return ""
  }

  // 📖 结构化返回：目录树列表
  async list(path: string): Promise<string> {
    const fullPath = this.getSafePath(path);
    try {
      const files = await readdir(fullPath, { withFileTypes: true });
      if (files.length === 0) return `目录 "${path}" 为空。`;
      
      const items = files.map(f => ({
        '@_type': f.isDirectory() ? 'dir' : 'file',
        '#text': f.isDirectory() ? `${f.name}/` : f.name
      }));

      return builder.build({
        directory: {
          '@_path': path,
          item: items
        }
      });
    } catch (e: any) {
      if (e.code === 'ENOENT') return `错误：目录 "${path}" 不存在。`;
      throw e;
    }
  }

  // 📖 结构化返回：Glob 路径匹配列表
  async glob(pattern: string, limit: number): Promise<string> {
    const files = await glob(pattern, { cwd: BASE_DIR, nodir: true, absolute: true });
    
    const validPaths: string[] = [];
    for (const file of files) {
      if (validPaths.length >= limit) break;
      
      const normalized = file.replace(/\\/g, '/');
      const baseNormalized = BASE_DIR.replace(/\\/g, '/');
      
      if (!normalized.startsWith(baseNormalized)) {
        continue;
      }
      
      const relPath = relative(BASE_DIR, file).replace(/\\/g, '/');
      validPaths.push(`/${relPath}`);
    }
    
    if (validPaths.length === 0) return `未找到匹配 "${pattern}" 的路径。`;
    
    return builder.build({
      matched_paths: {
        '@_pattern': pattern,
        '@_count': validPaths.length,
        path: validPaths
      }
    });
  }

  // 📖 结构化返回：Grep 精确匹配列表
  async grep(pattern: string, path: string | undefined, ignoreCase: boolean): Promise<string> {
    const searchDir = path ? this.getSafePath(path) : BASE_DIR;
    const files = await glob('**/*', { cwd: searchDir, nodir: true, absolute: true });
    
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    } catch {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, ignoreCase ? 'gi' : 'g');
    }

    const matches: any[] = [];
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf-8');
        const lines = content.split('\n');
        const relPath = relative(BASE_DIR, file).replace(/\\/g, '/');
        
        lines.forEach((line, index) => {
          if (regex.test(line)) {
            matches.push({
              '@_path': `/${relPath}`,
              '@_line': index + 1,
              '#text': line.trim()
            });
            regex.lastIndex = 0; 
          }
        });
      } catch {}
    }
    
    if (matches.length === 0) return `未找到匹配 "${pattern}" 的内容。`;
    
    return builder.build({
      grep_results: {
        '@_pattern': pattern,
        '@_count': matches.length,
        match: matches
      }
    });
  }
}