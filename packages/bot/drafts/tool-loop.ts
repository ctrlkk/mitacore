import type { ModelMessage, LanguageModelUsage, ToolSet, ToolResultPart } from "ai";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import { getModel } from "@/ai/model";
import { logger } from "@/logger";
import { getErrorMessage } from "@ai-sdk/provider-utils";

type ChatRecord = {
  message: ModelMessage;
  timestamp: number;
  usage?: LanguageModelUsage;
};

const demoTools: ToolSet = {
  get_weather: tool({
    description: "获取指定城市的天气信息",
    inputSchema: z.object({
      city: z.string().describe("城市名称"),
    }),
    execute: async ({ city }) => `${city}：晴，25°C`,
  }),

  calculate: tool({
    description: "执行数学计算",
    inputSchema: z.object({
      expression: z.string().describe("数学表达式，如 2+3*4"),
    }),
    execute: async ({ expression }) => {
      if (!/^[\d\s()+\-*/%.]+$/.test(expression)) {
        throw new Error("表达式只能包含数字、空白和 + - * / % . () 运算符");
      }
      const result = new Function(`return ${expression}`)();
      return { expression, result };
    },
  }),
};

/** 从工具定义中剥离 execute，只保留 schema 给模型看 */
function withoutExecutors(toolSet: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(toolSet).map(([name, { execute, ...rest }]) => [name, rest]));
}

/**
 * 工具循环-手动进行工具调用
 */
async function runManualToolLoop() {
  const toolsForGenerate = withoutExecutors(demoTools);
  let messages: ModelMessage[] = [{ role: "user", content: "北京天气怎么样？顺便算一下 (12 + 8) * 3" }];

  for (let step = 0; step < 10; step++) {
    const result = await generateText({
      model: getModel("deepseek-v4-flash"),
      instructions: "你是一个助手，可以查询天气和做计算。",
      messages,
      tools: toolsForGenerate,
      maxOutputTokens: 1024,
    });

    for (const step of result.steps) {
      logger.info({ response: step.reasoningText, text: step.text }, "助手响应");
      for (const stepMessage of step.response.messages) {
        messages.push(stepMessage);
      }
    }

    if (result.finalStep.toolCalls.length === 0) break;

    // 手动执行每个工具调用，构造 ToolResultPart
    const toolResults: ToolResultPart[] = await Promise.all(
      result.finalStep.toolCalls.map(async (tc) => {
        logger.info({ toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input }, "工具调用");

        const toolDef = demoTools[tc.toolName]!;

        try {
          const rawOutput = await toolDef.execute!(tc.input, {
            toolCallId: tc.toolCallId,
            messages,
            context: {},
          });

          return {
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output:
              typeof rawOutput === "string" ? { type: "text", value: rawOutput } : { type: "json", value: rawOutput },
          };
        } catch (error) {
          return {
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: "error-text", value: getErrorMessage(error) },
          };
        }
      }),
    );
    messages.push({ role: "tool", content: toolResults });
  }
}

/**
 * 工具循环-自动进行工具调用，精细化管理上下文
 */
async function runAutomaticToolLoop() {
  const toModelMessages = (records: ChatRecord[]): ModelMessage[] => records.map((r) => r.message);

  const historyMessages: ChatRecord[] = [];
  const runtimeMessages: ChatRecord[] = [
    {
      message: { role: "user", content: "北京天气怎么样？顺便算一下 (12 + 8) * 3" },
      timestamp: Date.now(),
    },
  ];

  for (let step = 0; step < 10; step++) {
    const { finalStep } = await generateText({
      model: getModel("deepseek-v4-flash"),
      instructions: "你是一个助手，可以查询天气和做计算。",
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
      tools: demoTools,
      maxOutputTokens: 1024,
      onToolExecutionStart({ toolCall }) {
        logger.info(
          { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input },
          "工具调用",
        );
      },
      onToolExecutionEnd({ toolOutput }) {
        if (toolOutput.type === "tool-result") {
          logger.info({ output: toolOutput.output }, "工具执行成功");
        } else {
          logger.info({ error: toolOutput.error }, "工具执行失败");
        }
      },
      onStepEnd(step) {
        logger.info({ response: step.reasoningText, text: step.text }, "助手响应");
        for (const [index, message] of step.response.messages.entries()) {
          runtimeMessages.push({ message, timestamp: Date.now(), usage: index === 0 ? step.usage : undefined });
        }
      },
    });

    if (finalStep.toolCalls.length === 0) break;
  }
}

/**
 * 工具循环-自动进行工具调用，精细化管理上下文，流式输出
 */
async function runStreamingToolLoop() {
  const toModelMessages = (records: ChatRecord[]): ModelMessage[] => records.map((r) => r.message);

  const historyMessages: ChatRecord[] = [];
  const runtimeMessages: ChatRecord[] = [
    {
      message: { role: "user", content: "北京天气怎么样？顺便算一下 (12 + 8) * 3" },
      timestamp: Date.now(),
    },
  ];

  let hasToolCalls = true;
  for (let step = 0; step < 10 && hasToolCalls; step++) {
    const streamResult = streamText({
      model: getModel("deepseek-v4-flash"),
      instructions: "你是一个助手，可以查询天气和做计算。",
      messages: toModelMessages([...historyMessages, ...runtimeMessages]),
      tools: demoTools,
      maxOutputTokens: 1024,
    });

    hasToolCalls = false;

    for await (const event of streamResult.fullStream) {
      switch (event.type) {
        case "text-delta":
          process.stdout.write(event.text);
          break;
        case "tool-call":
          hasToolCalls = true;
          logger.info({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }, "工具调用");
          break;
        case "tool-result":
          logger.info({ output: event.output }, "工具执行成功");
          break;
        case "tool-error":
          logger.info({ error: event.error }, "工具执行失败");
          break;
      }
    }
    process.stdout.write("\n");

    const responseMessages = await streamResult.responseMessages;
    const finalStep = await streamResult.finalStep;
    logger.info({ response: finalStep.reasoningText, text: finalStep.text }, "助手响应");
    for (const [index, message] of responseMessages.entries()) {
      runtimeMessages.push({ message, timestamp: Date.now(), usage: index === 0 ? finalStep.usage : undefined });
    }
  }
}

if (import.meta.main) {
  void runStreamingToolLoop();
}
