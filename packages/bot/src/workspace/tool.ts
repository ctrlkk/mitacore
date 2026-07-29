import { z } from "zod";
import { tool } from "ai";
import { createFsStorage } from "./storage";

const storage = await createFsStorage();

export const memoryTools = {
  read: tool({
    description:
      "读取文件内容或列出目录条目。如果是目录，每行列出一个条目，子目录以 `/` 结尾。" +
      "如果是文件，返回带行号的内容，格式为 `行号: 内容`。\n\n" +
      "用法：\n" +
      "- 默认从文件开头读取最多 100 行。\n" +
      "- offset 参数指定起始行号（从 0 开始）。\n" +
      "- 要读取后续部分，再次调用此工具并传入更大的 offset。\n" +
      "- 超过 2000 字符的行会被截断。\n" +
      "- 在大文件中查找特定内容时，请使用 grep 工具。\n" +
      "- 如果不确定路径，请先用 glob 工具查找。\n" +
      "- 如果需要读取多个文件，请并行调用此工具。",
    inputSchema: z.object({
      path: z.string().describe("文件或目录路径"),
      offset: z.number().optional().default(0).describe("起始行号（从 0 开始）"),
      limit: z.number().optional().default(100).describe("最多读取行数"),
    }),
    execute: async (args) => storage.read(args.path, args.offset, args.limit),
  }),

  write: tool({
    description:
      "将内容写入文件。如果设置了 overwrite=true，则覆写已有文件。\n\n" +
      "用法：\n" +
      "- 如果文件已存在，必须先用 Read 工具读取其内容，否则会失败。\n" +
      "- 优先编辑已有文件，除非明确要求，否则不要创建新文件。\n" +
      "- 覆写是破坏性操作，必须显式设置 overwrite=true 才能覆写已有文件。",
    inputSchema: z.object({
      path: z.string().describe("文件或目录路径"),
      content: z.string().describe("完整内容"),
      overwrite: z.boolean().optional().default(false).describe("路径已存在时是否强制覆盖"),
    }),
    execute: async (args) => storage.write(args.path, args.content, args.overwrite),
  }),

  edit: tool({
    description:
      "对文件内容进行精确字符串替换。\n\n" +
      "用法：\n" +
      "- 编辑前必须先使用 Read 工具读取文件内容。\n" +
      "- 从 Read 输出中编辑时，确保保留行号前缀之后的精确缩进（制表符/空格）。" +
      "行号前缀格式为：行号 + `:` + 空格（如 `1: `），空格之后才是实际内容。\n" +
      "- 如果 old_string 未找到，会报错。\n" +
      "- 如果 old_string 匹配到多处，会报错，请提供更多上下文使其唯一。\n" +
      "- 优先编辑已有文件，除非明确要求，否则不要创建新文件。",
    inputSchema: z.object({
      path: z.string().describe("文件或目录路径"),
      old_string: z.string().describe("要替换的精确文本（必须在文件中唯一）"),
      new_string: z.string().describe("替换后的新文本"),
    }),
    execute: async (args) => storage.edit(args.path, args.old_string, args.new_string),
  }),

  delete: tool({
    description:
      "删除文件或目录。如果是目录，会递归删除所有子文件和子目录。\n\n" +
      "用法：\n" +
      "- 删除目录需要设置 confirm=true 以防止意外数据丢失。\n" +
      "- 此操作不可逆。",
    inputSchema: z.object({
      path: z.string().describe("文件或目录路径"),
      confirm: z.boolean().optional().default(false).describe("删除目录时必须为 true"),
    }),
    execute: async (args) => storage.delete(args.path, args.confirm),
  }),

  glob: tool({
    description:
      "快速路径模式匹配工具。\n\n" +
      '- 支持 glob 通配符，如 "**/*.md" 或 "docs/**/*.txt"\n' +
      "- 返回按修改时间排序的匹配路径（最近修改的在前）\n" +
      "- 当需要按名称模式查找文件时使用此工具\n" +
      "- 最好一次性批量执行多个可能有用的搜索。",
    inputSchema: z.object({
      pattern: z.string().describe("Glob 通配符模式，支持 * 和 **"),
      path: z.string().optional().describe("限定搜索的目录，不填则搜索整个工作区"),
      limit: z.number().optional().default(100).describe("最多返回的匹配数量"),
    }),
    execute: async (args) => storage.glob(args.pattern, args.path, args.limit),
  }),

  grep: tool({
    description:
      "快速内容搜索工具。\n\n" +
      '- 支持完整的正则表达式语法（如 "TODO.*fix"、"function\\s+\\w+"）\n' +
      "- 返回包含匹配的文件路径和行号\n" +
      "- 结果按文件修改时间排序（最近修改的在前）\n" +
      '- 可通过 include 参数限定文件类型（如 "*.ts"）\n' +
      "- 当需要查找包含特定模式的文件时使用此工具。",
    inputSchema: z.object({
      pattern: z.string().describe("正则表达式或纯文本搜索词"),
      path: z.string().optional().describe("限定搜索的目录或文件路径"),
      include: z.string().optional().describe('限定文件类型，如 "*.ts" 或 "*.{ts,tsx}"'),
      ignore_case: z.boolean().optional().default(false).describe("是否忽略大小写"),
    }),
    execute: async (args) => storage.grep(args.pattern, args.path, args.include, args.ignore_case),
  }),
};
