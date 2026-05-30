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
  /** 外部传入的初始对话上下文（只读），Agent 不会修改此数组 */
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
  
  /** Agent 是否已完成执行 */
  private completed = false
  
  /** Agent 是否正在执行中（防重入锁） */
  private running = false
  
  /** 当前已执行的步数计数器 */
  private stepCount: number = 0
  
  /** 
   * 内部消息轨迹（可变）
   * 存放 Agent 执行过程中产生的助手回复、工具调用及工具结果
   */
  private internalMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  /**
   * 构造函数
   * @param config - Agent 配置和运行时上下文
   */
  constructor(
    private readonly config: AgentConfig<TContext>,
  ) {}

  /**
   * 获取最终发给 LLM 的完整消息列表
   * 外部上下文 (只读) + 内部轨迹 (可变)
   */
  private get fullMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return [...this.config.messages, ...this.internalMessages]
  }

  /**
   * 运行 Agent 直到完成
   *
   * 该方法封装了完整的执行循环，简化调用方代码：
   * 1. 循环调用 step() 直到 Agent 完成
   * 2. 每次迭代都会触发 onStep 回调
   * 3. 自动处理 LLM 响应和工具调用
   *
   * @param onStep - 每步执行的回调函数
   * @returns 最终的完整消息历史记录（包含外部上下文和内部轨迹）
   */
  async run(
    onStep?: (result: { choice: OpenAI.Chat.ChatCompletion.Choice; usage?: OpenAI.CompletionUsage }) => Promise<void>
  ) {
    let usage: OpenAI.CompletionUsage | undefined = undefined
    while (!this.done()) {
      for await (const result of this.step()) {
        await onStep?.(result)
        usage = result.usage
      }
    }
    return {
      fullMessages: this.fullMessages,
      usage,
    }
  }

  /**
   * 执行单步推理
   *
   * @returns 异步生成器，每次 yield 产生一个包含 choice 和 usage 的结果对象
   */
  async* step() {
    // 防重入锁，避免并发调用 step() 导致状态混乱
    if (this.running) {
      throw new Error('Agent is already running')
    }

    this.running = true
    this.stepCount++

    // 优雅降级：超出最大步数时，注入系统提示引导 LLM 结束，而非抛出异常崩溃
    if (this.stepCount > this.config.maxSteps) {
      this.internalMessages.push({
        role: 'user',
        content: '你已达到最大执行步数限制，请立刻根据目前掌握的信息给出最终回答，不要再调用任何工具。',
      })
    }

    // 动态构建 OpenAI 所需的 tools 数组格式
    const openaiTools: OpenAI.Chat.ChatCompletionTool[] = Object.entries(this.config.tools).map(([name, toolDef]) => ({
      type: 'function',
      function: {
        name,
        description: toolDef.description,
        parameters: zodToJsonSchema(toolDef.inputSchema, { target: 'openApi3' }),
      },
    }))

    const response = await this.config.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      messages: [
        { role: 'system', content: this.config.systemPrompt },
        ...this.fullMessages,
      ],
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    })

    const choice = response.choices[0]
    if (!choice || !choice.message) {
      this.running = false // 释放锁
      throw new Error('API 返回了无效的响应：缺少 choice 或 message')
    }

    const message = choice.message

    // 将助手响应追加到内部轨迹
    this.internalMessages.push(message)

    // 处理对话完成的情况
    if (choice.finish_reason === 'stop') {
      this.completed = true
      this.running = false
      yield { choice, usage: response.usage }
      return // 终止生成器
    }

    // 处理工具调用的情况
    if (choice.finish_reason === 'tool_calls' && message.tool_calls) {
      // 先 yield 让调用方知道即将开始执行工具
      yield { choice, usage: response.usage }
      
      const toolResults = await this.executeToolCall(message.tool_calls)
      // 将工具结果追加到内部轨迹
      this.internalMessages.push(...toolResults)
    }

    this.running = false
  }

  /**
   * 执行工具调用
   * @param toolCalls - LLM 返回的工具调用列表
   * @returns 工具执行结果列表
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
          messages: this.fullMessages, // 传入完整的消息历史
          experimental_context: this.config.context,
        }

        const result = await toolDef.execute(parsedInput.data, options)

        // 修复双重序列化和 undefined 的边界问题
        let resultContent: string
        if (typeof result === 'string') {
          resultContent = result
        } else {
          // JSON.stringify(undefined) 会返回 undefined(非字符串)，导致 API 报错，需转为 null
          resultContent = JSON.stringify(result === undefined ? null : result)
        }

        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultContent,
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
   * 检查 Agent 是否已完成执行
   */
  done() {
    return this.completed
  }

  /**
   * 重置 Agent 状态
   * 清空内部轨迹，使其可以被复用开启新的对话分支
   */
  reset() {
    this.internalMessages = []
    this.completed = false
    this.running = false
    this.stepCount = 0
  }
}
