import type { LanguageModelUsage, ModelMessage } from "ai";

export type ChatRecord = {
  message: ModelMessage;
  timestamp: number;
  /** 该 record 对应最近一次 generateText 调用的 usage */
  usage?: LanguageModelUsage;
  /** 是否为摘要记录 */
  summary?: boolean;
};

export type ChatHistory = ChatRecord[];

/** 转换为 AI SDK 原生格式 */
export const toModelMessages = (records: ChatHistory): ModelMessage[] => records.map((r) => r.message);

/** 迁移：兼容旧的裸 ModelMessage[] 格式 */
export function migrateHistory(raw: unknown, fallbackTimestamp = Date.now()): ChatHistory {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ChatRecord[] => {
    if (!item || typeof item !== "object") return [];
    // 已是新格式（只要包含 message 字段就是新格式）
    if ("message" in item) {
      return [item as ChatRecord];
    }
    // 旧格式：裸 ModelMessage
    if ("role" in item) {
      return [
        {
          message: item as ModelMessage,
          timestamp: fallbackTimestamp,
        },
      ];
    }
    return [];
  });
}
