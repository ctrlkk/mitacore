/**
 * 自定义 generateText 工具调用循环示例
 *
 * 核心思路：generateText 默认会自动执行工具，我们通过 stripToolExecutors 去掉 execute，
 * 只把工具定义（名称、描述、参数 schema）传给模型，然后自己接管执行和结果回传。
 *
 * 为什么这么做：
 *   - 控制执行时机（比如加审批、限流、日志）
 *   - 控制结果格式（toModelOutput 自定义输出给模型的内容）
 *   - 控制错误处理（决定错误以什么形式回传给模型）
 */

import { generateText, type JSONValue, type ModelMessage, type Tool, type ToolResultPart, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { tool } from "ai";

// ── 配置 ──────────────────────────────────────────────────────

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_API_BASE!,
})("gpt-4o-mini");

// ── 工具定义 ──────────────────────────────────────────────────

const tools: Record<string, Tool> = {
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
      // 简单演示，实际不要用 eval
      const result = new Function(`return ${expression}`)();
      return { expression, result };
    },
  }),
};

// ── 工具调用循环的基础设施 ────────────────────────────────────

/** 从工具定义中剥离 execute，只保留 schema 给模型看 */
function stripToolExecutors(tools: Record<string, Tool>): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, { execute, ...rest }]) => [name, rest]));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function toJSONValue(value: unknown): JSONValue {
  return value === undefined ? null : (value as JSONValue);
}

/**
 * 将工具输出转为模型能理解的 ToolResultOutput 格式。
 * 逻辑与 SDK 内部 createToolModelOutput 一致：
 *   - 错误时：error-text（纯文本错误信息）或 error-json（JSON 错误信息）
 *   - 有 toModelOutput：调用工具自定义的输出转换
 *   - 字符串输出：text
 *   - 其他：json
 */
async function toToolResultOutput(
  tool: Tool | undefined,
  toolCallId: string,
  input: unknown,
  output: unknown,
  errorMode: "none" | "text" | "json",
) {
  if (errorMode === "text") return { type: "error-text" as const, value: getErrorMessage(output) };
  if (errorMode === "json") return { type: "error-json" as const, value: toJSONValue(output) };

  if (tool?.toModelOutput) {
    return await tool.toModelOutput({ toolCallId, input, output });
  }

  if (typeof output === "string") return { type: "text" as const, value: output };
  return { type: "json" as const, value: toJSONValue(output) };
}

// ── 主循环 ────────────────────────────────────────────────────

async function run() {
  const toolsForGenerate = stripToolExecutors(tools);
  let messages: ModelMessage[] = [{ role: "user", content: "北京天气怎么样？顺便算一下 (12 + 8) * 3" }];

  for (let step = 0; step < 10; step++) {
    const result = await generateText({
      model,
      system: "你是一个助手，可以查询天气和做计算。",
      messages,
      tools: toolsForGenerate,
    });

    // 把模型的响应消息（包含 tool-call）加入历史
    messages.push(...result.response.messages);

    if (result.text) {
      console.log("助手:", result.text);
    }

    // 没有工具调用就结束
    if (result.toolCalls.length === 0) break;

    // 手动执行每个工具调用，构造 ToolResultPart
    const toolResults: ToolResultPart[] = await Promise.all(
      result.toolCalls.map(async (tc) => {
        console.log(`[工具调用] ${tc.toolName}(${JSON.stringify(tc.input)})`);
        const toolDef = tools[tc.toolName];
        let output: unknown;
        let errorMode: "none" | "text" | "json" = "none";

        try {
          if (toolDef?.execute) {
            output = await toolDef.execute(tc.input, {
              toolCallId: tc.toolCallId,
              messages,
            });
          }
        } catch (error) {
          output = error;
          errorMode = "text";
        }

        console.log(`[工具结果]`, output);

        return {
          type: "tool-result" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: await toToolResultOutput(toolDef, tc.toolCallId, tc.input, output, errorMode),
        };
      }),
    );

    // 把工具结果作为 tool 消息加入历史，下一轮模型会看到
    messages.push({ role: "tool", content: toolResults });
  }
}

run();
