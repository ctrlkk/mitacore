/**
 * 分支工具草稿：演示一个能"克隆主代理"的分支工具 + 通过 cache 命中率验证对话完全继承。
 *
 * 主代理 = generateText + 多个普通工具 + branch 工具
 * 分支代理 = 同一份 model / system / tools（不裁剪、不改 schema）、同一份 messages
 *
 * 验证思路：
 * - Anthropic 等 provider 支持 prompt cache，相同前缀会命中缓存
 * - 如果分支完全继承 outer 的对话前缀，分支调用的 cache_read 应占 input 的绝大部分
 * - 只多出来的 <branch_task> 消息会写入新缓存（cache_write），其余全部 hit
 *
 * 运行：
 *   bun run packages/bot/drafts/branch.ts
 */

import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { getModel } from "@/model";

const model = getModel("deepseek-v4-flash");

const baseTools: Record<string, Tool> = {
  get_weather: tool({
    description: "获取指定城市的天气",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => `${city}：晴，25°C`,
  }),
  calculate: tool({
    description: "执行数学计算",
    inputSchema: z.object({ expression: z.string() }),
    execute: async ({ expression }) => {
      const result = new Function(`return (${expression})`)();
      return { result };
    },
  }),
};

const parentSystem = [
  "你是一个助手，能查天气、做数学计算。",
  "你还可以通过 branch 工具派生一个克隆分支去独立完成子任务。",
  "分支会继承你的对话历史、系统提示词与全部工具，请把可以独立完成的子任务交给它。",
  "拿到分支结论后请用一句话总结回复用户。",
].join("\n");

function formatUsage(label: string, u: LanguageModelUsage | undefined): string {
  if (!u) return `${label}: 无 usage`;
  const input = u.inputTokens ?? 0;
  const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const written = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  const uncached = u.inputTokenDetails?.noCacheTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const reasoning = u.outputTokenDetails?.reasoningTokens ?? 0;
  const hitRate = input > 0 ? ((cached / input) * 100).toFixed(1) : "0.0";
  return [
    `${label}:`,
    `  input=${input}  cached=${cached} (命中率 ${hitRate}%)  written=${written}  uncached=${uncached}`,
    `  output=${output}  reasoning=${reasoning}`,
  ].join("\n");
}

function createBranchTool(allTools: ToolSet, parentSystem: string, parentModel: LanguageModel) {
  return tool({
    description:
      "派生一个当前对话的克隆分支执行独立任务。" +
      "分支会继承相同的对话历史、系统提示词与全部工具，" +
      "完成后返回一段中文结论。",
    inputSchema: z.object({
      task: z.string().describe("交给分支代理执行的具体任务"),
    }),
    execute: async ({ task }, { messages, abortSignal, experimental_context }) => {
      const inBranch = (experimental_context as { inBranch?: boolean } | undefined)?.inBranch === true;
      if (inBranch) {
        return "[branch] 分支代理不允许再次派生分支，已忽略本次调用。请直接完成手头的任务。";
      }

      const branchInput = [
        `<branch_task>`,
        task,
        ``,
        `[身份] 你是当前对话派生出的分支代理，请独立完成上述任务并返回结论。`,
        `[约束] 你不能再调用 branch 工具派生下一层分支。`,
        `</branch_task>`,
      ].join("\n");

      console.log(`\n[branch] 派生任务: ${task}`);
      console.log(`[branch] 继承消息数: ${messages.length}`);
      console.log(`[branch] 工具集（含 branch 自身）: ${Object.keys(allTools).join(", ")}`);

      const branchAbort = abortSignal ?? AbortSignal.timeout(300_000);
      const result = await generateText({
        model: parentModel,
        system: parentSystem,
        messages: [...messages, { role: "user", content: branchInput }],
        tools: allTools,
        abortSignal: branchAbort,
        experimental_context: { inBranch: true },
        stopWhen: stepCountIs(5),
        onStepFinish({ stepNumber, toolCalls, text, usage }) {
          const tcList = toolCalls.map((t) => `${t.toolName}(${JSON.stringify(t.input)})`).join(", ") || "无";
          const tx = text ? text.slice(0, 60).replaceAll("\n", " ") : "";
          console.log(`  [branch.step ${stepNumber}] toolCalls=${tcList} text=${tx ? `"${tx}…"` : "无"}`);
          console.log(formatUsage(`  [branch.step ${stepNumber} usage]`, usage));
        },
      });
      console.log(formatUsage("[branch totalUsage]", result.totalUsage));
      console.log(`[branch] 完成，结论长度: ${result.text.length} 字符`);
      return result.text;
    },
  });
}

const allTools: Record<string, Tool> = { ...baseTools };
allTools.branch = createBranchTool(allTools, parentSystem, model);

async function run() {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: "帮我查一下北京的天气，再算一下 (12+8)*3 的结果。请通过 branch 工具把这两件事作为子任务派出去执行。",
    },
  ];

  console.log(`[outer] 起始工具集: ${Object.keys(allTools).join(", ")}`);

  const outerAbort = AbortSignal.timeout(300_000);
  const { text, totalUsage } = await generateText({
    model,
    system: parentSystem,
    messages,
    tools: allTools,
    stopWhen: stepCountIs(5),
    abortSignal: outerAbort,
    onStepFinish({ stepNumber, toolCalls, text, usage }) {
      const tcList = toolCalls.map((t) => `${t.toolName}(${JSON.stringify(t.input)})`).join(", ") || "无";
      const tx = text ? text.slice(0, 60).replaceAll("\n", " ") : "";
      console.log(`[outer.step ${stepNumber}] toolCalls=${tcList} text=${tx ? `"${tx}…"` : "无"}`);
      console.log(formatUsage(`[outer.step ${stepNumber} usage]`, usage));
    },
  });

  console.log(formatUsage("\n[outer totalUsage]", totalUsage));
  console.log("\n=== 主代理最终回复 ===");
  console.log(text);
}

run();
