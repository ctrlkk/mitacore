import type { MentionableUser } from "@/message/mention";
import type { MessagePart } from "@/message/parts";

/** 上层消息队列使用的最小渠道能力，屏蔽 OneBot 与微信协议差异。 */
export interface ChannelReplyContext {
  platform: "onebot" | "weixin";
  conversationType: "private" | "group";
  selfId: string;
  reply(message: MessagePart, mentionableUsers?: MentionableUser[]): Promise<unknown>;
  setTyping(): Promise<() => void | Promise<void>>;
}
