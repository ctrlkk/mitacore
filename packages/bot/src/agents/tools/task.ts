import { workspaceTools } from "@/workspace/tool";
import { getModelForRole } from "@/ai/model";
import { generateText, isStepCount, tool } from "ai";
import { logger, type PinoLogger } from "@/logger";
import { logUsage } from "@/utils/format";
import { z } from "zod";
import taskPrompt from "./task.txt";

export function task(log: PinoLogger = logger) {
  return tool({
    description: taskPrompt.trim(),
    inputSchema: z.object({
      description: z.string().describe("简短描述(3-5字)"),
      prompt: z.string().describe("详细任务描述"),
      subagent_type: z.enum(["explore", "general"]).describe("子代理类型"),
    }),
    async execute({ description, prompt, subagent_type }, { abortSignal }) {
      const { default: workspacePrompt } = await import("@/workspace/memory.txt");

      if (subagent_type === "explore") {
        const { text, finishReason } = await generateText({
          model: getModelForRole("task_explore"),
          system:
            "<role>\n" +
            "你是一个知识库检索专家，擅长快速浏览和搜索结构化笔记。\n" +
            "使用 glob 搜索文件，grep 搜索内容，read 读取已知文件。\n" +
            "禁止创建或修改任何文件。只做搜索和读取。\n" +
            "</role>\n\n" +
            "<workspace_instructions>\n" +
            `${workspacePrompt.trim()}\n` +
            "</workspace_instructions>\n",
          messages: [{ role: "user", content: prompt }],
          tools: { read: workspaceTools.read, grep: workspaceTools.grep, glob: workspaceTools.glob },
          stopWhen: isStepCount(20),
          maxOutputTokens: 5024,
          abortSignal,
          async onLanguageModelCallEnd({ content, usage }) {
            const reasoningText = content
              .filter((part) => part.type === "reasoning")
              .map((part) => part.text)
              .join("");
            const text = content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
            log.info({ reasoningText, text }, "explore 任务响应");
            logUsage(log, usage);
          },
          onToolExecutionStart({ toolCall }) {
            log.info(
              { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input },
              "工具调用",
            );
          },
          onToolExecutionEnd({ toolCall }) {
            log.info({ toolName: toolCall.toolName }, "工具执行结束");
          },
        });
        return `<task id="${description}" state="${finishReason === "stop" ? "completed" : "incomplete"}">\n<task_result>\n${text}\n</task_result>\n</task>`;
      }

      if (subagent_type === "general") {
        const { text, finishReason } = await generateText({
          model: getModelForRole("task_general"),
          system:
            "<role>\n" +
            "你是一个通用助手，可以执行复杂的多步任务。\n" +
            "你可以读取、搜索、创建、修改和整理知识库文件。\n" +
            "请自主完成任务并返回总结。\n" +
            "</role>\n\n" +
            "<workspace_instructions>\n" +
            `${workspacePrompt.trim()}\n` +
            "</workspace_instructions>\n",
          messages: [{ role: "user", content: prompt }],
          tools: workspaceTools,
          stopWhen: isStepCount(20),
          maxOutputTokens: 5024,
          abortSignal,
          async onLanguageModelCallEnd({ content, usage }) {
            const reasoningText = content
              .filter((part) => part.type === "reasoning")
              .map((part) => part.text)
              .join("");
            const text = content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
            log.info({ reasoningText, text }, "general 任务响应");
            logUsage(log, usage);
          },
          onToolExecutionStart({ toolCall }) {
            log.info(
              { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input },
              "工具调用",
            );
          },
          onToolExecutionEnd({ toolCall }) {
            log.info({ toolName: toolCall.toolName }, "工具执行结束");
          },
        });
        return `<task id="${description}" state="${finishReason === "stop" ? "completed" : "incomplete"}">\n<task_result>\n${text}\n</task_result>\n</task>`;
      }

      return "没有这样的subagent：" + subagent_type;
    },
  });
}
