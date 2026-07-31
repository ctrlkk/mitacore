import { workspaceTools } from "@/workspace/tool";
import { getModel } from "@/ai/model";
import { generateText, isStepCount, tool } from "ai";
import { websearch } from "./web-search";
import { z } from "zod";

export function task() {
  return tool({
    description:
      "将复杂任务委托给专门的子代理独立完成。\n" +
      "使用场景：需要并行执行多个独立任务、深度代码搜索、任务拆分。\n" +
      "不要用于：读单个文件(用read)、搜索代码(用grep/glob)。\n" +
      "使用规则：可并发启动多个；分配后不要重复工作；子代理每次全新会话。\n" +
      "可用类型：\n" +
      "- explore: 快速代码库探索，擅长搜索文件内容\n" +
      "- general: 通用型，适合执行复杂多步任务",
    inputSchema: z.object({
      description: z.string().describe("简短描述(3-5字)"),
      prompt: z.string().describe("详细任务描述"),
      subagent_type: z.string().describe("子代理类型: explore / general"),
    }),
    async execute({ description, prompt, subagent_type }, { context }) {
      if (subagent_type === "explore") {
        const { text } = await generateText({
          model: getModel("deepseek-v4-flash"),
          system:
            "你是一个文件搜索专家，擅长快速浏览和搜索代码库。\n" +
            "使用 glob 搜索文件，grep 搜索内容，read 读取已知文件。\n" +
            "禁止创建或修改任何文件。只做搜索和读取。",
          messages: [{ role: "user", content: prompt }],
          tools: { read: workspaceTools.read, grep: workspaceTools.grep, glob: workspaceTools.glob },
          stopWhen: isStepCount(20),
          maxOutputTokens: 5024,
        });
        return `<task id="${description}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`;
      }

      if (subagent_type === "general") {
        const { text } = await generateText({
          model: getModel("deepseek-v4-flash"),
          system:
            "你是一个通用助手，可以执行复杂的多步任务。\n" +
            "你可以读取文件、搜索代码、执行命令、搜索网络。\n" +
            "请自主完成任务并返回总结。",
          messages: [{ role: "user", content: prompt }],
          tools: {
            read: workspaceTools.read,
            grep: workspaceTools.grep,
            glob: workspaceTools.glob,
            write: workspaceTools.write,
            edit: workspaceTools.edit,
            copy: workspaceTools.copy,
            move: workspaceTools.move,
            delete: workspaceTools.delete,
            websearch: websearch(),
          },
          stopWhen: isStepCount(20),
          maxOutputTokens: 5024,
        });
        return `<task id="${description}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`;
      }

      return "没有这样的subagent：" + subagent_type;
    },
  });
}
