import { z } from 'zod';

export interface ToolExecutionOptions {
  toolCallId: string;
  messages: any[];
  abortSignal?: AbortSignal;
  experimental_context?: unknown;
}

export type ToolExecuteFunction<INPUT, OUTPUT> = (
  input: INPUT,
  options: ToolExecutionOptions,
) => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT> | OUTPUT;

export interface ToolDefinition<INPUT, OUTPUT> {
  description?: string;
  inputSchema: z.ZodSchema<INPUT>;
  execute: ToolExecuteFunction<INPUT, OUTPUT>;
  strict?: boolean;
}

export type Tool<INPUT = any, OUTPUT = any> = ToolDefinition<INPUT, OUTPUT>;

export type InferToolInput<T extends Tool> = T extends Tool<infer I, any> ? I : never;
export type InferToolOutput<T extends Tool> = T extends Tool<any, infer O> ? O : never;

export function tool<INPUT, OUTPUT>(
  definition: ToolDefinition<INPUT, OUTPUT>,
): Tool<INPUT, OUTPUT> {
  return definition;
}
