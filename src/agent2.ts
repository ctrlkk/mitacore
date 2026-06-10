import { generateText, tool, type ModelMessage, type LanguageModel, type ToolExecutionOptions } from "ai"
import { z, type ZodType } from "zod"

/**
 * 工具定义 — 用 zod schema 自动推导输入类型
 */
export interface ToolDef<TInput extends ZodType, TContext> {
  description?: string
  inputSchema: TInput
  execute: (input: z.infer<TInput>, options: ToolExecutionOptions & { context: TContext }) => Promise<unknown> | unknown
}

/** 便捷构造函数 */
export function toolDef<T extends ZodType, C>(def: ToolDef<T, C>): ToolDef<T, C> {
  return def
}

/**
 * 生成参数（与 opencode 一致）
 */
export interface GenerateParams {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  presencePenalty?: number
  frequencyPenalty?: number
  providerOptions?: Record<string, any>
}

/**
 * Agent 配置
 */
export interface AgentConfig<TContext> {
  model: LanguageModel
  systemPrompt: string
  messages?: ModelMessage[]
  tools?: Record<string, ToolDef<any, TContext>>
  context: TContext
  maxSteps?: number
  params?: GenerateParams
}

/**
 * 单步执行结果
 */
export interface StepResult {
  text: string
  reasoning: { type: "reasoning"; text: string; }[]
  hasToolCalls: boolean
  toolCalls: { toolName: string; input: unknown }[]
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number,
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  }
}

/**
 * Agent 执行器
 */
export class Agent<TContext> {
  private completed = false
  private running = false
  private stepCount = 0
  private internalMessages: ModelMessage[] = []

  constructor(private readonly config: AgentConfig<TContext>) {}

  private get fullMessages(): ModelMessage[] {
    return [...(this.config.messages ?? []), ...this.internalMessages]
  }

  done() {
    return this.completed
  }

  reset() {
    this.internalMessages = []
    this.completed = false
    this.running = false
    this.stepCount = 0
  }

  async run(
    userMessage?: string | ((result: StepResult) => Promise<void> | void),
    onStep?: (result: StepResult) => Promise<void> | void,
  ) {
    if (typeof userMessage === "function") {
      onStep = userMessage
      userMessage = undefined
    }
    if (userMessage) {
      this.internalMessages.push({ role: "user", content: userMessage })
    }

    let lastUsage: StepResult["usage"] = {}
    while (!this.done()) {
      const result = await this.step()
      await onStep?.(result)
      lastUsage = result.usage
    }
    return { messages: this.fullMessages, usage: lastUsage }
  }

  async step(): Promise<StepResult> {
    if (this.running) throw new Error("Agent is already running")
    this.running = true
    this.stepCount++

    if (this.stepCount > (this.config.maxSteps ?? 10)) {
      this.internalMessages.push({
        role: "user",
        content: "已达到最大步数限制，请根据已有信息给出最终回答，不要再调用工具。",
      })
    }

    if (this.fullMessages.length === 0) {
      throw new Error("No messages to process. Pass a user message to run() or provide messages in config.")
    }

    const tools = this.buildTools()
    const params = this.config.params ?? {}

    const result = await generateText({
      model: this.config.model,
      system: this.config.systemPrompt,
      messages: this.fullMessages,
      tools,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      maxOutputTokens: params.maxOutputTokens,
      presencePenalty: params.presencePenalty,
      frequencyPenalty: params.frequencyPenalty,
      providerOptions: params.providerOptions,
    })

    this.internalMessages.push(...result.response.messages)

    const lastMsg = result.response.messages.at(-1)
    const hasToolCalls = lastMsg?.role === "tool"
    const toolCalls = (result.toolCalls ?? []).map((tc) => ({
      toolName: tc.toolName,
      input: tc.input,
    }))

    if (!hasToolCalls) {
      this.completed = true
    }

    this.running = false

    return {
      text: result.text,
      reasoning: result.reasoning,
      hasToolCalls,
      toolCalls,
      usage: result.usage,
    }
  }

  /**
   * 构建 AI SDK 工具定义
   * 将用户的 ToolDef 转为 AI SDK 的 tool() 格式，注入 context
   */
  private buildTools() {
    if (!this.config.tools) return undefined
    return Object.fromEntries(
      Object.entries(this.config.tools).map(([name, def]) => [
        name,
        tool({
          description: def.description,
          inputSchema: def.inputSchema,
          execute: async (input, options) => {
            return def.execute(input, { ...options, context: this.config.context })
          },
        }),
      ]),
    )
  }
}
