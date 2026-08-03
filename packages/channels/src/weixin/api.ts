import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { MessageItemType, type GetUpdatesResponse, type MessageItem, type WeixinCredentials } from "./protocol";

const CHANNEL_VERSION = "2.4.6";
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const WEIXIN_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

interface ApiOptions {
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: "AgentsBot/1.0" };
}

function headers(token?: string): Record<string, string> {
  const wechatUin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": wechatUin,
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function url(endpoint: string) {
  return new URL(endpoint, `${WEIXIN_API_BASE_URL}/`).toString();
}

async function requestJson<T>(endpoint: string, body: unknown, options: ApiOptions): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? 15_000);
  const abort = () => timeoutController.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url(endpoint), {
      method: "POST",
      headers: headers(options.token),
      body: JSON.stringify(body),
      signal: timeoutController.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function getUpdates(
  credentials: WeixinCredentials,
  syncBuffer: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GetUpdatesResponse> {
  try {
    return await requestJson<GetUpdatesResponse>(
      "ilink/bot/getupdates",
      { get_updates_buf: syncBuffer, base_info: baseInfo() },
      { token: credentials.token, timeoutMs, signal },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && !signal?.aborted) {
      return { ret: 0, msgs: [], get_updates_buf: syncBuffer };
    }
    throw error;
  }
}

export async function sendText(
  credentials: WeixinCredentials,
  to: string,
  contextToken: string | undefined,
  text: string,
) {
  const response = await requestJson<{ ret?: number; errmsg?: string }>(
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `agents-bot:${Date.now()}-${randomBytes(4).toString("hex")}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: baseInfo(),
    },
    { token: credentials.token },
  );
  if (response.ret && response.ret !== 0) throw new Error(`微信发送失败：${response.errmsg ?? response.ret}`);
}

export async function getTypingTicket(credentials: WeixinCredentials, userId: string, contextToken?: string) {
  return await requestJson<{ ret?: number; typing_ticket?: string }>(
    "ilink/bot/getconfig",
    { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
    { token: credentials.token, timeoutMs: 10_000 },
  );
}

export async function sendTyping(credentials: WeixinCredentials, userId: string, ticket: string, status: 1 | 2) {
  await requestJson(
    "ilink/bot/sendtyping",
    { ilink_user_id: userId, typing_ticket: ticket, status, base_info: baseInfo() },
    { token: credentials.token, timeoutMs: 10_000 },
  );
}

export async function notifyLifecycle(credentials: WeixinCredentials, state: "start" | "stop") {
  return await requestJson<{ ret?: number; errmsg?: string }>(
    `ilink/bot/msg/notify${state}`,
    { base_info: baseInfo() },
    { token: credentials.token, timeoutMs: 10_000 },
  );
}

function parseAesKey(encoded: string) {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`无效的微信媒体 AES key 长度：${decoded.length}`);
}

export async function downloadMedia(item: MessageItem): Promise<Buffer | null> {
  const media = item.image_item?.media ?? item.video_item?.media ?? item.file_item?.media ?? item.voice_item?.media;
  if (!media) return null;
  const aesKey = (() => {
    if (item.image_item?.aeskey) return Buffer.from(item.image_item.aeskey, "hex");
    if (media.aes_key) return parseAesKey(media.aes_key);
    return null;
  })();
  let mediaUrl = media.full_url;
  if (!mediaUrl && media.encrypt_query_param) {
    mediaUrl = `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  }
  if (!mediaUrl) return null;
  const response = await fetch(mediaUrl);
  if (!response.ok) throw new Error(`微信媒体下载失败：HTTP ${response.status}`);
  const encrypted = Buffer.from(await response.arrayBuffer());
  if (!aesKey) return encrypted;
  const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function uploadEncrypted(buffer: Buffer, targetUrl: string, aesKey: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });
  if (!response.ok) throw new Error(`微信 CDN 上传失败：HTTP ${response.status}`);
  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("微信 CDN 上传响应缺少 x-encrypted-param");
  return { downloadParam, encryptedSize: encrypted.length };
}

export async function sendImage(
  credentials: WeixinCredentials,
  to: string,
  contextToken: string | undefined,
  buffer: Buffer,
) {
  const aesKey = randomBytes(16);
  const fileKey = randomBytes(16).toString("hex");
  const paddedSize = Math.ceil((buffer.length + 1) / 16) * 16;
  const upload = await requestJson<{ upload_param?: string; upload_full_url?: string }>(
    "ilink/bot/getuploadurl",
    {
      filekey: fileKey,
      media_type: 1,
      to_user_id: to,
      rawsize: buffer.length,
      rawfilemd5: createHash("md5").update(buffer).digest("hex"),
      filesize: paddedSize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: baseInfo(),
    },
    { token: credentials.token },
  );
  let targetUrl = upload.upload_full_url;
  if (!targetUrl && upload.upload_param) {
    targetUrl = `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(fileKey)}`;
  }
  if (!targetUrl) throw new Error("微信 getUploadUrl 未返回上传地址");
  const uploaded = await uploadEncrypted(buffer, targetUrl, aesKey);

  const response = await requestJson<{ ret?: number; errmsg?: string }>(
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `agents-bot:${Date.now()}-${randomBytes(4).toString("hex")}`,
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadParam,
                // openclaw-weixin 的发送实现使用 base64(hex key)，微信 CDN 同时也会返回这种编码。
                aes_key: Buffer.from(aesKey.toString("hex"), "ascii").toString("base64"),
                encrypt_type: 1,
              },
              mid_size: uploaded.encryptedSize,
            },
          },
        ],
        context_token: contextToken,
      },
      base_info: baseInfo(),
    },
    { token: credentials.token },
  );
  if (response.ret && response.ret !== 0) throw new Error(`微信图片发送失败：${response.errmsg ?? response.ret}`);
}
