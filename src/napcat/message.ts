// ============================================================
// 统一消息类型 — 跨平台 (飞书 / NapCat) 的最小公共抽象
// ============================================================

// ---------- 出站消息 (Bot → 平台) ----------

/** 纯文本 */
export interface TextMessage {
  type: "text";
  text: string;
}

/** 图片 */
export interface ImageMessage {
  type: "image";
  /** 图片 URL 或 base64 */
  url: string;
}

/** @某人 */
export interface AtMessage {
  type: "at";
  /** 目标用户 ID (平台相关)，"all" 表示 @所有人 */
  targetId: string;
  /** @后附加文本，可选 */
  text?: string;
}

/** 回复消息 */
export interface ReplyMessage {
  type: "reply";
  /** 被回复的消息 ID */
  messageId: string;
  /** 回复内容 */
  content: UniversalMessage;
}

/** 平台专属消息，兜底 */
export interface PlatformMessage {
  type: "platform";
  /** 平台名称 "lark" | "napcat" */
  platform: string;
  /** 原始平台数据 */
  raw: unknown;
}

/** 统一出站消息类型 */
export type UniversalMessage =
  | TextMessage
  | ImageMessage
  | AtMessage
  | ReplyMessage
  | PlatformMessage;

/** 从 UniversalMessage[] 中提取纯文本 */
export function extractText(segments: UniversalMessage[]): string {
  return segments
    .filter((seg): seg is Extract<UniversalMessage, { type: "text" }> => seg.type === "text")
    .map((seg) => seg.text)
    .join("");
}

// ---------- 入站消息 (平台 → Bot) ----------

export interface InboundMessage {
  /** 平台来源 */
  platform: "lark" | "napcat";
  /** 会话 ID (飞书 chatId / NapCat 可由 user_id 或 group_id 拼出) */
  chatId: string;
  /** 发送者 ID */
  senderId: string;
  /** 消息 ID */
  messageId: string;
  /** 纯文本内容 */
  text: string;
  /** 结构化消息段 */
  segments: UniversalMessage[];
  /** 消息时间戳 (ms) */
  timestamp: number;
  /** 是否群聊 */
  isGroup: boolean;
  /** 平台原始事件 */
  raw: unknown;
}

// ---------- 统一 Channel 接口 ----------

export interface SendOptions {
  /** 回复某条消息 */
  replyTo?: string;
}

export interface UniversalChannel {
  /** 连接平台 */
  connect(): Promise<void>;
  /** 断开连接 */
  disconnect(): void;
  /** 发送消息 */
  send(chatId: string, message: UniversalMessage, opts?: SendOptions): Promise<{ messageId: string }>;
  /** 监听入站消息 */
  onMessage(listener: (msg: InboundMessage) => void | Promise<void>): void;
  /** 监听错误 */
  onError(listener: (err: Error) => void): void;
}
