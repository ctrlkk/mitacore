export type HistoryRecord = {
  message: { role: string; content: unknown };
  timestamp: number;
  user_turn?: number;
  summary?: boolean;
  system_update?: unknown;
  usage?: unknown;
};

export type MessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
};

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

export function messageParts(content: unknown): MessagePart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "unknown", output: content }];
  return content.map((part): MessagePart => {
    if (!part || typeof part !== "object" || typeof part.type !== "string") return { type: "unknown", output: part };
    return {
      type: part.type,
      text: typeof part.text === "string" ? part.text : undefined,
      toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : undefined,
      toolName: typeof part.toolName === "string" ? part.toolName : undefined,
      input: part.input,
      output: "output" in part ? part.output : "result" in part ? part.result : part,
    };
  });
}

export function formatToolOutput(output: unknown): string {
  if (output && typeof output === "object" && "type" in output && "value" in output) {
    return formatValue(output.value);
  }
  return formatValue(output);
}

/** submit_plan 的返回由 planner.ts 包装，消息正文保留原始换行。 */
export function submitPlanReply(output: unknown): string {
  const content = formatToolOutput(output);
  const prefix = "<reply_result>\n<content>\n";
  const suffix = "\n</content>\n</reply_result>";
  return content.startsWith(prefix) && content.endsWith(suffix)
    ? content.slice(prefix.length, -suffix.length)
    : content;
}

export function collectToolParts(records: HistoryRecord[]) {
  const calls = new Set<string>();
  const results = new Map<string, MessagePart>();
  for (const record of records) {
    for (const part of messageParts(record.message.content)) {
      if (record.message.role === "assistant" && part.type === "tool-call" && part.toolCallId) {
        calls.add(part.toolCallId);
      }
      if (record.message.role === "tool" && part.type === "tool-result" && part.toolCallId) {
        results.set(part.toolCallId, part);
      }
    }
  }
  return { calls, results };
}
