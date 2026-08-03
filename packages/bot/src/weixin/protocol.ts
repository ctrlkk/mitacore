/** 基于 vendor/openclaw-weixin 2.4.6（MIT）的微信 iLink JSON 协议子集。 */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string };
  voice_item?: { media?: CdnMedia; text?: string };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  video_item?: { media?: CdnMedia; video_size?: number };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

export interface WeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
}
