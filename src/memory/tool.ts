import { z } from 'zod';
import { tool, type Tool } from '../tool.js';
import { FsMemoryStorage } from './storage.js';

const storage = new FsMemoryStorage();

export const minimalistMemoryTools: Record<string, Tool> = {
  read_memory: tool({
    description: '读取指定记忆节点的内容。返回带行号的文本，支持分页读取长文件。',
    inputSchema: z.object({
      path: z.string().describe('记忆节点路径'),
      offset: z.number().optional().default(0).describe('起始行号（从0开始）'),
      limit: z.number().optional().default(100).describe('最多读取行数'),
    }),
    execute: async (args) => storage.read(args.path, args.offset, args.limit),
  }),

  write_memory: tool({
    description: '创建新记忆或全量覆写已有记忆。覆写是破坏性操作，需显式设置 overwrite=true。',
    inputSchema: z.object({
      path: z.string().describe('节点路径'),
      content: z.string().describe('完整正文'),
      overwrite: z.boolean().optional().default(false).describe('若路径已存在，是否强制全量覆盖（默认false）'),
    }),
    execute: async (args) => storage.write(args.path, args.content, args.overwrite),
  }),

  edit_memory: tool({
    description: '外科手术式局部编辑。通过精确替换 old_string 为 new_string 来修改内容。old_string 必须在文件中唯一存在。',
    inputSchema: z.object({
      path: z.string().describe('节点路径'),
      old_string: z.string().describe('必须是在文件中唯一存在的精确文本片段'),
      new_string: z.string().describe('替换后的新文本'),
    }),
    execute: async (args) => storage.edit(args.path, args.old_string, args.new_string),
  }),

  delete_memory: tool({
    description: '删除记忆节点。若包含子节点会级联删除，需设置 confirm=true 确认。',
    inputSchema: z.object({
      path: z.string().describe('节点路径'),
      confirm: z.boolean().optional().default(false).describe('确认删除（包含子节点时必填）'),
    }),
    execute: async (args) => storage.delete(args.path, args.confirm),
  }),

  // search_memory: tool({
  //   description: '语义搜索记忆库。通过自然语言查询找到相关记忆节点。（当前后端降级为全文关键字搜索）',
  //   inputSchema: z.object({
  //     query: z.string().describe('搜索词，如"用户的饮食禁忌"'),
  //     limit: z.number().optional().default(10).describe('最多返回的匹配数量'),
  //   }),
  //   execute: async (args) => storage.search(args.query, args.limit),
  // }),

  list_memory: tool({
    description: '列出指定目录下的记忆节点结构。类似 ls 命令。',
    inputSchema: z.object({
      path: z.string().optional().default('/').describe('目录路径前缀，默认为根目录'),
    }),
    execute: async (args) => storage.list(args.path),
  }),

  glob_memory: tool({
    description: '使用通配符模式匹配记忆节点路径。仅返回路径列表。',
    inputSchema: z.object({
      pattern: z.string().describe('Glob通配符，支持 * , ** 等语法'),
      limit: z.number().optional().default(20).describe('最多返回的匹配数量'),
    }),
    execute: async (args) => storage.glob(args.pattern, args.limit),
  }),

  grep_memory: tool({
    description: '在记忆节点内容中搜索特定文本或正则表达式。适用于精确定位文本位置。',
    inputSchema: z.object({
      pattern: z.string().describe('要搜索的文本或正则表达式'),
      path: z.string().optional().describe('限定搜索的目录前缀'),
      ignore_case: z.boolean().optional().default(false).describe('是否忽略大小写'),
    }),
    execute: async (args) => storage.grep(args.pattern, args.path, args.ignore_case),
  }),
};