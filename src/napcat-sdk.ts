import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import WebSocket from "ws";

export interface NapCatOptions {
  wsUrl: string;
  token?: string;
  /** API 请求超时时间 (ms)，默认 30000 */
  timeout?: number;
  /** 是否启用自动重连，默认 true */
  autoReconnect?: boolean;
  /** 重连间隔 (ms)，默认 3000 */
  reconnectInterval?: number;
}

export interface MessageSegment {
  type: string;
  data: Record<string, any>;
}

export interface OneBotEvent {
  time: number;
  self_id: number;
  post_type: "message" | "notice" | "request" | "meta_event" | "message_sent";
  [key: string]: any;
}

export interface MessageEvent extends OneBotEvent {
  post_type: "message" | "message_sent";
  message_type: "private" | "group";
  message_id: number;
  user_id: number;
  message: MessageSegment[] | string;
  raw_message: string;
  sender: Record<string, any>;
  group_id?: number;
}

export interface NoticeEvent extends OneBotEvent {
  post_type: "notice";
  notice_type: string;
}

export interface RequestEvent extends OneBotEvent {
  post_type: "request";
  request_type: string;
  flag: string;
}

export interface MetaEvent extends OneBotEvent {
  post_type: "meta_event";
  meta_event_type: "heartbeat" | "lifecycle";
}

export interface ApiResponse<T = any> {
  status: "ok" | "failed";
  retcode: number;
  message: string;
  data: T;
  echo: string;
}

export interface NapCatEvents {
  message: (event: MessageEvent) => void | Promise<void>;
  notice: (event: NoticeEvent) => void | Promise<void>;
  request: (event: RequestEvent) => void | Promise<void>;
  meta_event: (event: MetaEvent) => void | Promise<void>;
  message_sent: (event: MessageEvent) => void | Promise<void>;
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
}

export declare interface NapCatChannel {
  on<U extends keyof NapCatEvents>(event: U, listener: NapCatEvents[U]): this;
  emit<U extends keyof NapCatEvents>(event: U, ...args: Parameters<NapCatEvents[U]>): boolean;
}

export class NapCatChannel extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: NapCatOptions;
  
  // 修复：原代码 Map 泛型缺少闭合括号 >
  private pendingRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }
  >();
  
  private isManualClose = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromiseResolve: (() => void) | null = null;
  private connectPromiseReject: ((err: Error) => void) | null = null;

  constructor(options: NapCatOptions) {
    super();
    this.options = {
      timeout: 30000,
      autoReconnect: true,
      reconnectInterval: 3000,
      ...options,
    };
  }

  public connect(): Promise<void> {
    this.isManualClose = false;
    return new Promise((resolve, reject) => {
      this.connectPromiseResolve = resolve;
      this.connectPromiseReject = reject;
      this.setupWebSocket(true);
    });
  }

  private setupWebSocket(isFirstConnect = false): void {
    // 清理旧连接，防止内存泄漏
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }

    const headers = this.options.token
      ? { Authorization: `Bearer ${this.options.token}` }
      : undefined;

    this.ws = new WebSocket(this.options.wsUrl, { headers });

    this.ws.on("open", () => {
      this.emit("open");
      if (isFirstConnect && this.connectPromiseResolve) {
        this.connectPromiseResolve();
        this.connectPromiseResolve = null;
        this.connectPromiseReject = null;
      }
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
      if (isFirstConnect && this.connectPromiseReject) {
        this.connectPromiseReject(err);
        this.connectPromiseReject = null;
        this.connectPromiseResolve = null;
      }
    });

    this.ws.on("close", () => {
      for (const [echo, req] of this.pendingRequests) {
        clearTimeout(req.timeout);
        req.reject(new Error("WebSocket 连接已关闭"));
        this.pendingRequests.delete(echo);
      }
      this.emit("close");
      
      if (isFirstConnect && this.connectPromiseReject) {
        this.connectPromiseReject(new Error("WebSocket 连接已关闭"));
        this.connectPromiseReject = null;
        this.connectPromiseResolve = null;
      }
      
      this.tryReconnect();
    });

    this.ws.on("message", (rawData) => this.handleMessage(rawData));
  }

  private tryReconnect(): void {
    if (this.isManualClose || !this.options.autoReconnect) return;
    
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    this.reconnectTimer = setTimeout(() => {
      // 重连时 isFirstConnect 为 false，避免触发未捕获的 Promise 异常
      this.setupWebSocket(false);
    }, this.options.reconnectInterval);
  }

  public disconnect(): void {
    this.isManualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  /** 泛型 API 调用 */
  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<ApiResponse<T>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    const echo = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`API [${action}] 请求超时`));
      }, this.options.timeout);

      this.pendingRequests.set(echo, { resolve, reject, timeout });

      this.ws!.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pendingRequests.delete(echo);
          reject(err);
        }
      });
    });
  }

  private handleMessage(rawData: WebSocket.RawData): void {
    let parsed: any;
    try {
      parsed = JSON.parse(rawData.toString());
    } catch {
      this.emit("error", new Error("JSON 解析失败"));
      return;
    }

    // 1. API 响应 (包含 echo 和 retcode)
    if (parsed.echo && typeof parsed.retcode === "number") {
      const req = this.pendingRequests.get(parsed.echo);
      if (req) {
        clearTimeout(req.timeout);
        this.pendingRequests.delete(parsed.echo);
        if (parsed.status === "failed") {
          req.reject(new Error(parsed.message || "API 调用失败"));
        } else {
          req.resolve(parsed);
        }
      }
      return;
    }

    // 2. OneBot 事件分发
    if (parsed.post_type) {
      this.emit(parsed.post_type as keyof NapCatEvents, parsed);
    }
  }
}

export function createNapCatChannel(options: NapCatOptions): NapCatChannel {
  return new NapCatChannel(options);
}
