import { QQBotHttpClient, type QQBotHttpClientOptions } from "./api";
import {
  QQBotGatewayEvent,
  QQBotGatewayOp,
  type QQBotCredentials,
  type QQBotGatewayPayload,
  type QQBotInboundMessage,
  type QQBotMessageResponse,
  type QQBotReplyTarget,
} from "./protocol";

export interface QQBotWebSocket {
  readonly readyState: number;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: any) => void,
    options?: AddEventListenerOptions,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export interface QQBotClientOptions extends QQBotHttpClientOptions {
  intents?: number;
  reconnect?: boolean;
  webSocketFactory?: (url: string) => QQBotWebSocket;
}

type Handler<T> = (value: T) => void | Promise<void>;

const DEFAULT_INTENTS = 1 << 25;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 100;

/** QQ 官方 Bot Gateway 客户端，仅支持 WebSocket 入站与 HTTP 文本发送。 */
export class QQBotClient {
  private readonly http: QQBotHttpClient;
  private readonly intents: number;
  private readonly reconnect: boolean;
  private readonly webSocketFactory: (url: string) => QQBotWebSocket;
  private socket: QQBotWebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private ready = false;
  private sessionId: string | null = null;
  private lastSequence: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly messageHandlers = new Set<Handler<QQBotInboundMessage>>();
  private readonly readyHandlers = new Set<Handler<void>>();
  private readonly closeHandlers = new Set<Handler<{ code: number; reason: string }>>();
  private readonly errorHandlers = new Set<Handler<unknown>>();

  constructor(credentials: QQBotCredentials, options: QQBotClientOptions = {}) {
    this.http = new QQBotHttpClient(credentials, options);
    this.intents = options.intents ?? DEFAULT_INTENTS;
    this.reconnect = options.reconnect ?? true;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  get isConnected() {
    return this.ready;
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connectPromise) return await this.connectPromise;
    this.closedByUser = false;
    this.connectPromise = this.openConnection().finally(() => {
      this.connectPromise = null;
    });
    return await this.connectPromise;
  }

  close(code = 1000, reason = "normal") {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.socket?.close(code, reason);
    this.socket = null;
    this.ready = false;
  }

  onMessage(handler: Handler<QQBotInboundMessage>) {
    return addHandler(this.messageHandlers, handler);
  }

  onReady(handler: Handler<void>) {
    return addHandler(this.readyHandlers, handler);
  }

  onClose(handler: Handler<{ code: number; reason: string }>) {
    return addHandler(this.closeHandlers, handler);
  }

  onError(handler: Handler<unknown>) {
    return addHandler(this.errorHandlers, handler);
  }

  async sendText(target: QQBotReplyTarget, text: string): Promise<QQBotMessageResponse> {
    return await this.http.sendText(target, text);
  }

  async reply(message: QQBotInboundMessage, text: string): Promise<QQBotMessageResponse> {
    return await this.sendText(message.replyTarget, text);
  }

  private async openConnection(): Promise<void> {
    const gatewayUrl = await this.http.getGatewayUrl();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.webSocketFactory(gatewayUrl);
      this.socket = socket;

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.addEventListener("open", () => undefined, { once: true });
      socket.addEventListener("error", (event) => {
        this.emit(this.errorHandlers, event);
        fail(new Error("QQ Bot WebSocket 连接失败"));
      });
      socket.addEventListener("close", (event) => {
        const code = typeof event.code === "number" ? event.code : 1006;
        const reason = typeof event.reason === "string" ? event.reason : "";
        const wasReady = this.ready;
        this.handleClose(socket, code, reason);
        if (!wasReady) fail(new Error("QQ Bot WebSocket 在准备完成前关闭"));
      });
      socket.addEventListener("message", (event) => {
        this.handleSocketMessage(event.data, socket)
          .then(() => {
            if (this.ready && !settled) {
              settled = true;
              resolve();
            }
          })
          .catch((error) => {
            this.emit(this.errorHandlers, error);
            fail(error);
          });
      });
    });
  }

  private async handleSocketMessage(data: unknown, socket: QQBotWebSocket) {
    const text = await messageDataToString(data);
    const payload = JSON.parse(text) as QQBotGatewayPayload;
    if (typeof payload.s === "number") this.lastSequence = payload.s;

    if (payload.op === QQBotGatewayOp.HELLO) {
      this.startHeartbeat(socket, payload.d);
      await this.identify(socket);
      return;
    }
    if (payload.op === QQBotGatewayOp.DISPATCH) {
      await this.handleDispatch(payload);
      return;
    }
    if (payload.op === QQBotGatewayOp.RECONNECT) {
      socket.close(4000, "QQ Bot 请求重连");
      return;
    }
    if (payload.op === QQBotGatewayOp.INVALID_SESSION) {
      if (payload.d === false) this.clearSession();
      socket.close(4000, "QQ Bot session 无效");
    }
  }

  private async identify(socket: QQBotWebSocket) {
    const token = await this.http.getAccessToken();
    if (this.sessionId && this.lastSequence !== null) {
      socket.send(
        JSON.stringify({
          op: QQBotGatewayOp.RESUME,
          d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSequence },
        }),
      );
      return;
    }
    socket.send(
      JSON.stringify({
        op: QQBotGatewayOp.IDENTIFY,
        d: { token: `QQBot ${token}`, intents: this.intents, shard: [0, 1] },
      }),
    );
  }

  private async handleDispatch(payload: QQBotGatewayPayload) {
    if (payload.t === QQBotGatewayEvent.READY) {
      const sessionId = readString(payload.d, "session_id");
      if (!sessionId) throw new Error("QQ Bot READY 事件缺少 session_id");
      this.sessionId = sessionId;
      this.ready = true;
      this.reconnectAttempts = 0;
      this.emit(this.readyHandlers, undefined);
      return;
    }
    if (payload.t === QQBotGatewayEvent.RESUMED) {
      this.ready = true;
      this.reconnectAttempts = 0;
      this.emit(this.readyHandlers, undefined);
      return;
    }
    const message = normalizeMessage(payload.t, payload.d);
    if (message) this.emit(this.messageHandlers, message);
  }

  private startHeartbeat(socket: QQBotWebSocket, hello: unknown) {
    this.clearHeartbeat();
    const interval = readNumber(hello, "heartbeat_interval");
    if (!interval) throw new Error("QQ Bot HELLO 事件缺少 heartbeat_interval");
    const heartbeat = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ op: QQBotGatewayOp.HEARTBEAT, d: this.lastSequence }));
    };
    heartbeat();
    this.heartbeatTimer = setInterval(heartbeat, interval);
  }

  private handleClose(socket: QQBotWebSocket, code: number, reason: string) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.clearHeartbeat();
    this.emit(this.closeHandlers, { code, reason });

    if ([4006, 4007, 4009, 4914, 4915].includes(code)) this.clearSession();
    if (code === 4004) this.http.clearAccessToken();
    if (this.closedByUser || !this.reconnect || code === 1000 || [4914, 4915].includes(code)) return;
    this.scheduleReconnect(code === 4008 ? 60_000 : undefined);
  }

  private scheduleReconnect(delay?: number) {
    if (this.reconnectTimer || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    const timeout = delay ?? RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.emit(this.errorHandlers, error);
        if (!this.closedByUser) this.scheduleReconnect();
      });
    }, timeout);
  }

  private clearSession() {
    this.sessionId = null;
    this.lastSequence = null;
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private emit<T>(handlers: Set<Handler<T>>, value: T) {
    for (const handler of handlers) Promise.resolve(handler(value)).catch(() => undefined);
  }
}

function normalizeMessage(eventName: string | undefined, value: unknown): QQBotInboundMessage | null {
  if (!isRecord(value)) return null;
  if (eventName === QQBotGatewayEvent.C2C_MESSAGE_CREATE) {
    const senderId = readString(value.author, "user_openid");
    const messageId = readString(value, "id");
    if (!senderId || !messageId) return null;
    return createMessage("c2c", senderId, senderId, messageId, value);
  }
  if (eventName === QQBotGatewayEvent.GROUP_AT_MESSAGE_CREATE || eventName === QQBotGatewayEvent.GROUP_MESSAGE_CREATE) {
    const senderId = readString(value.author, "member_openid");
    const groupId = readString(value, "group_openid");
    const messageId = readString(value, "id");
    if (!senderId || !groupId || !messageId) return null;
    return createMessage("group", senderId, groupId, messageId, value);
  }
  return null;
}

function createMessage(
  kind: "c2c" | "group",
  senderId: string,
  targetId: string,
  messageId: string,
  raw: Record<string, unknown>,
): QQBotInboundMessage {
  return {
    kind,
    content: readString(raw, "content") ?? "",
    messageId,
    senderId,
    senderName: readString(raw.author, "username"),
    timestamp: readString(raw, "timestamp"),
    attachments: Array.isArray(raw.attachments) ? raw.attachments.filter(isRecord) : [],
    replyTarget: { scope: kind, targetId, msgId: messageId },
    raw,
  };
}

function addHandler<T>(handlers: Set<Handler<T>>, handler: Handler<T>) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, key: string) {
  if (!isRecord(value) || typeof value[key] !== "string") return undefined;
  return value[key];
}

function readNumber(value: unknown, key: string) {
  if (!isRecord(value) || typeof value[key] !== "number") return undefined;
  return value[key];
}

async function messageDataToString(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  return String(data);
}
