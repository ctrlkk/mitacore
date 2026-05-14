import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { type Tool, type ToolExecutionOptions } from './tool.js'

/**
 * Agent 运行配置
 * 定义了 Agent 执行所需的核心参数和上下文
 */
interface AgentConfig<TContext> {
  /** OpenAI 兼容的客户端实例 (如指向 DeepSeek 的客户端) */
  client: OpenAI
  /** 使用的模型名称，如 'deepseek-chat'、'deepseek-reasoner' */
  model: string
  /** 系统提示词，定义 Agent 的角色和行为 */
  systemPrompt: string
  /** 温度参数 (0-2)，控制输出的随机性和创造性 */
  temperature?: number
  /** 对话消息历史，会被修改以包含工具结果 */
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  /** 工具映射表，键为工具名，值为通过 tool() 函数定义的工具 */
  tools: Record<string, Tool<any, any>>
  /** 运行时上下文，传递给工具执行函数 (如数据库连接、当前用户等) */
  context: TContext
  /** 最大执行步数，防止 Agent 陷入无限循环 */
  maxSteps: number
}

export class Agent<TContext> {
  /** Agent 唯一标识符 */
  readonly id = randomUUID()
  /** Agent 内部状态：空闲 | 运行中 | 已完成 */
  private state: 'idle' | 'running' | 'completed' = 'idle'
  /** 当前已执行的步数计数器 */
  private stepCount: number = 0

  /**
   * 构造函数
   * @param config - Agent 配置和运行时上下文
   */
  constructor(
    private readonly config: AgentConfig<TContext>,
  ) {}

  /**
   * 运行 Agent 直到完成
   *
   * 该方法封装了完整的执行循环，简化调用方代码：
   * 1. 循环调用 step() 直到 Agent 完成
   * 2. 每次迭代都会触发 onStep 回调
   * 3. 自动处理 LLM 响应和工具调用
   *
   * @param onStep - 每步执行的回调函数，接收当前步的 LLM 响应结果
   * - 回调时机：每当 step() yield 时触发，可用于监控进度或记录日志
   *
   * @returns 最终的消息历史记录，包含完整的推理和工具调用过程
   *
   * @example
   * ```typescript
   * const messages = await agent.run(async ({ choice, usage }) => {
   *   console.log('当前步数消耗 Token:', usage?.total_tokens)
   * })
   * ```
   */
  async run(onStep?: (result: { choice: OpenAI.Chat.ChatCompletion.Choice; usage?: OpenAI.CompletionUsage }) => Promise<void>): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    while (!this.done()) {
      for await (const result of this.step()) {
        await onStep?.(result)
      }
    }
    return this.config.messages
  }

  /**
   * 执行单步推理
   *
   * 该方法是一个异步生成器，执行一次完整的推理循环：
   * 1. 将 Zod Schema 动态转换为 OpenAI 需要的 JSON Schema
   * 2. 发起 LLM 请求
   * 3. 处理 LLM 响应：
   *    - 若 finish_reason 为 'stop'，标记完成并清空思考过程
   *    - 若 finish_reason 为 'tool_calls'，执行工具并将结果追加到消息历史
   *
   * @returns 异步生成器，每次 yield 产生一个包含 choice 和 usage 的结果对象
   *
   * @example
   * ```typescript
   * for await (const { choice, usage } of agent.step()) {
   *   console.log(choice.message.content)
   * }
   * ```
   */
  async* step() {
    this.state = 'running'
    this.stepCount++
    if (this.stepCount > this.config.maxSteps) {
      throw new Error(`Agent 执行步数 (${this.stepCount}) 超过最大限制`)
    }
    // 动态构建 OpenAI 所需的 tools 数组格式
    const openaiTools = Object.entries(this.config.tools).map(([name, toolDef]) => ({
      type: 'function' as const,
      function: {
        name,
        description: toolDef.description,
        parameters: zodToJsonSchema(toolDef.inputSchema, { target: 'openApi3' }),
      },
    }))
    const response = await this.config.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      messages: this.config.messages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    })
    const choice = response.choices[0]
    if (!choice || !choice.message) {
      throw new Error('API 返回了无效的响应：缺少 choice 或 message')
    }
    const message = choice.message
    // 将助手响应直接追加到历史记录（OpenAI API 要求包含工具调用时的完整 message）
    this.config.messages.push(message)
    // 处理对话完成的情况
    if (choice.finish_reason === 'stop') {
      this.clearReasoningContent()
      this.state = 'completed'
      yield { choice, usage: response.usage }
      return // 终止生成器
    }
    // 处理工具调用的情况
    if (choice.finish_reason === 'tool_calls' && message.tool_calls) {
      // 先 yield 让调用方知道即将开始执行工具（可用于 UI 展示正在加载）
      yield { choice, usage: response.usage }
      
      const toolResults = await this.executeToolCall(message.tool_calls)
      this.config.messages.push(...toolResults)
    }
    this.state = 'idle'
  }

  /**
   * 执行工具调用
   *
   * 遍历 LLM 请求的工具列表，执行对应的工具函数：
   * 1. 过滤非 'function' 类型的调用
   * 2. 使用 Zod 校验入参，若校验失败则将错误信息返回给 LLM 让其重试
   * 3. 将运行时上下文 (TContext) 注入到工具执行选项中
   * 4. 捕获执行异常，避免因单个工具报错导致整个 Agent 崩溃
   *
   * @param toolCalls - LLM 返回的工具调用列表
   * @returns 工具执行结果列表，格式符合 OpenAI ChatCompletionToolMessageParam
   */
  async executeToolCall(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[]) {
    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = []
    for (const toolCall of toolCalls) {
      // 类型缩窄：仅支持标准的 function 调用
      if (toolCall.type !== 'function') {
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `不支持的工具类型：${toolCall.type}`,
        })
        continue
      }
      const toolName = toolCall.function.name
      const toolDef = this.config.tools[toolName]
      if (!toolDef) {
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `There is no such tool: ${toolName}`,
        })
        continue
      }
      try {
        const input = JSON.parse(toolCall.function.arguments)
        
        // 使用 Zod 进行参数校验
        const parsedInput = toolDef.inputSchema.safeParse(input)
        if (!parsedInput.success) {
          // 将 Zod 的校验错误扁平化后返回给大模型，引导其修正参数
          toolResults.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: '参数校验失败', details: parsedInput.error.flatten() }),
          })
          continue
        }
        // 构造工具执行选项，注入上下文
        const options: ToolExecutionOptions = {
          toolCallId: toolCall.id,
          messages: this.config.messages,
          experimental_context: this.config.context, // 核心：将 TContext 传递给工具
        }
        const result = await toolDef.execute(parsedInput.data, options)
        
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        })
      } catch (error: any) {
        // 捕获执行异常，优雅地返回错误信息而非中断 Agent
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Execution Error: ${error.message || 'Unknown error'}`,
        })
      }
    }
    return toolResults
  }

  /**
   * 清除消息历史中的 reasoning_content
   * 
   * DeepSeek 等推理模型的思考过程 (reasoning_content) 往往非常长，
   * 在多轮对话或工具调用链中保留这些内容会迅速消耗 Token 导致上下文溢出。
   * 当 Agent 完成最终回复时，清理掉之前的思考过程是一种必要的优化。
   */
  clearReasoningContent() {
    for (const message of this.config.messages) {
      if (message.role === 'assistant' && 'reasoning_content' in message) {
        message.reasoning_content = undefined
      }
    }
  }
  
  /**
   * 检查 Agent 是否已完成执行
   * @returns 如果状态为 completed 则返回 true
   */
  done() {
    return this.state === 'completed'
  }
}
