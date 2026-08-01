import { generateText, isStepCount, type LanguageModel, type ToolSet } from "ai";
import type { ChatHistory } from "./chat-history";
import { toModelMessages } from "./chat-history";
import { logger, type PinoLogger } from "@/logger";
import { workspaceTools } from "@/workspace/tool";
import { logUsage } from "@/utils/format";

let reviewQueue = Promise.resolve();

/**
 * 创建继承主代理请求前缀的长期记忆复盘分支。
 * 分支保持 model、instructions 与工具定义一致，以复用主代理的 prompt cache；
 * 除 task 外的非工作区工具只在本地执行阶段拒绝，不改变发送给模型的工具 schema。
 */
export function memoryReview(
  allTools: ToolSet,
  parentSystem: string,
  parentModel: LanguageModel,
  log: PinoLogger = logger,
) {
  const workspaceToolNames = new Set(Object.keys(workspaceTools));

  return (history: ChatHistory): void => {
    const snapshot = [...history];
    reviewQueue = reviewQueue
      .catch((error) => log.error({ error }, "上一轮后台记忆复盘失败"))
      .then(async () => {
        const { default: template } = await import("../prompts/memory-review.txt");
        const branchInput = `<system_reminder>\n${template.trim()}\n</system_reminder>`;
        const branchTools: ToolSet = Object.fromEntries(
          Object.entries(allTools).map(([name, branchTool]) => {
            if (workspaceToolNames.has(name) || name === "task") return [name, branchTool];
            return [name, { ...branchTool, execute: async () => `后台记忆复盘禁止调用非工作区工具：${name}` }];
          }),
        );

        const result = await generateText({
          model: parentModel,
          instructions: parentSystem,
          messages: [...toModelMessages(snapshot), { role: "user", content: branchInput }],
          tools: branchTools,
          stopWhen: isStepCount(20),
          runtimeContext: { inSubagent: true },
          maxOutputTokens: 4096,
          onToolExecutionStart({ toolCall }) {
            log.info(
              { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input },
              "后台记忆复盘工具调用",
            );
          },
          onToolExecutionEnd({ toolCall }) {
            log.info({ toolName: toolCall.toolName }, "后台记忆复盘工具执行结束");
          },
        });

        logUsage(log, result.usage);
        log.info({ text: result.text, reasoningText: result.reasoningText }, "后台记忆复盘完成");
      })
      .catch((error) => log.error({ error }, "后台记忆复盘失败"));
  };
}
