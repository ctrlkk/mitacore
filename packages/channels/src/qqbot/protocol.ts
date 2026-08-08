export const QQBotGatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const QQBotGatewayEvent = {
  READY: "READY",
  RESUMED: "RESUMED",
  C2C_MESSAGE_CREATE: "C2C_MESSAGE_CREATE",
  GROUP_AT_MESSAGE_CREATE: "GROUP_AT_MESSAGE_CREATE",
  GROUP_MESSAGE_CREATE: "GROUP_MESSAGE_CREATE",
} as const;

export interface QQBotCredentials {
  appId: string;
  appSecret: string;
}

export type QQBotConversationType = "c2c" | "group";

export interface QQBotReplyTarget {
  scope: QQBotConversationType;
  targetId: string;
  msgId?: string;
}

export interface QQBotGatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string;
}

export interface QQBotAttachment {
  content_type?: string;
  filename?: string;
  height?: number;
  size?: number;
  url?: string;
  width?: number;
}

export interface QQBotInboundMessage {
  kind: QQBotConversationType;
  content: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  timestamp?: string;
  attachments: QQBotAttachment[];
  replyTarget: QQBotReplyTarget;
  raw: unknown;
}

export interface QQBotMessageResponse {
  id: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

export class QQBotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "QQBotApiError";
  }
}
