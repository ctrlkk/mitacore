interface UnifiedTextMessage {
  type: "text";
  text: string;
}
interface UnifiedAtMessage {
  type: "at";
  data: { userId: string; nickname: string };
}
interface UnifiedImageMessage {
  type: "image";
  data: { url: string };
}
interface UnifiedVideoMessage {
  type: "video";
  data: { url: string };
}
interface UnifiedAudioMessage {
  type: "audio";
  data: { url: string };
}
interface UnifiedReplyMessage {
  type: "reply";
  // 助手自身省略身份信息，避免随渠道账号或昵称变化；普通用户使用短号 u1、u2…。
  data: { segments: UnifiedInboundMessage[] } | { userId: string; nickname: string; segments: UnifiedInboundMessage[] };
}
export type UnifiedInboundMessage =
  | UnifiedTextMessage
  | UnifiedAtMessage
  | UnifiedImageMessage
  | UnifiedVideoMessage
  | UnifiedAudioMessage
  | UnifiedReplyMessage;

export type MediaKind = "image" | "video" | "audio";

export type MediaMap = Map<
  string,
  {
    kind: MediaKind;
    path: string;
    description: string;
  }
>;

export interface PendingMessage {
  userId: string; // 短号 u1、u2…，来自 user_alias
  unifiedMessages: UnifiedInboundMessage[];
  nickname: string;
  date: Date;
  isAt: boolean;
  /**
   * 标记一条消息是否已被 evaluationLoop 的触发判定逻辑"检查过"。
   */
  evaluated?: boolean;
  /**
   * 资源准备 Promise，在入队时立即启动下载与转述；
   * 不阻塞入队，对同一 URL 仅下载一次，对同一 path 仅转述一次。
   */
  resourcesPromise?: Promise<MediaMap>;
}
