import type { QQBotCredentials, QQBotMessageResponse, QQBotReplyTarget } from "./protocol";
import { QQBotApiError } from "./protocol";

type Fetcher = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

const DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com";
const DEFAULT_TOKEN_BASE_URL = "https://bots.qq.com";

export interface QQBotHttpClientOptions {
  apiBaseUrl?: string;
  fetch?: Fetcher;
  requestTimeoutMs?: number;
  tokenBaseUrl?: string;
  userAgent?: string;
}

interface AccessToken {
  value: string;
  refreshAt: number;
}

export class QQBotHttpClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly requestTimeoutMs: number;
  private readonly tokenBaseUrl: string;
  private readonly userAgent: string;
  private token: AccessToken | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(
    private readonly credentials: QQBotCredentials,
    options: QQBotHttpClientOptions = {},
  ) {
    this.apiBaseUrl = trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.tokenBaseUrl = trimTrailingSlash(options.tokenBaseUrl ?? DEFAULT_TOKEN_BASE_URL);
    this.userAgent = options.userAgent ?? "AgentsBot/1.0";
  }

  async getGatewayUrl(): Promise<string> {
    const response = await this.request<{ url?: string }>("/gateway", "GET");
    if (!response.url) throw new Error("QQ Bot Gateway 响应缺少 url");
    return response.url;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.refreshAt) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchAccessToken().finally(() => {
        this.tokenRequest = null;
      });
    }
    return await this.tokenRequest;
  }

  clearAccessToken() {
    this.token = null;
  }

  async sendText(target: QQBotReplyTarget, text: string): Promise<QQBotMessageResponse> {
    const path =
      target.scope === "c2c"
        ? `/v2/users/${encodeURIComponent(target.targetId)}/messages`
        : `/v2/groups/${encodeURIComponent(target.targetId)}/messages`;
    const body: Record<string, unknown> = { content: text, msg_type: 0 };
    if (target.msgId) {
      body.msg_id = target.msgId;
      body.msg_seq = nextMessageSequence();
    }
    return await this.request<QQBotMessageResponse>(path, "POST", body);
  }

  async sendTyping(target: QQBotReplyTarget): Promise<QQBotMessageResponse> {
    if (target.scope !== "c2c") throw new Error("QQ Bot 仅支持在单聊中设置输入状态");
    const path = `/v2/users/${encodeURIComponent(target.targetId)}/messages`;
    const body: Record<string, unknown> = {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
    };
    if (target.msgId) {
      body.msg_id = target.msgId;
      body.msg_seq = nextMessageSequence();
    }
    return await this.request<QQBotMessageResponse>(path, "POST", body);
  }

  private async fetchAccessToken(): Promise<string> {
    const response = await this.fetchWithTimeout(new URL("/app/getAppAccessToken", this.tokenBaseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({ appId: this.credentials.appId, clientSecret: this.credentials.appSecret }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new QQBotApiError(
        `QQ Bot token 请求失败：HTTP ${response.status}`,
        response.status,
        "/app/getAppAccessToken",
        body,
      );
    }

    const result = parseJson<{ access_token?: string; expires_in?: number }>(body, "/app/getAppAccessToken");
    if (!result.access_token) throw new Error("QQ Bot token 响应缺少 access_token");
    const expiresInMs = (result.expires_in ?? 7200) * 1000;
    const refreshEarlyMs = Math.min(5 * 60_000, expiresInMs / 3);
    this.token = { value: result.access_token, refreshAt: Date.now() + Math.max(0, expiresInMs - refreshEarlyMs) };
    return result.access_token;
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown, retried = false): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchWithTimeout(new URL(path, this.apiBaseUrl).toString(), {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = await response.text();
    if (response.status === 401 && !retried) {
      this.clearAccessToken();
      return await this.request<T>(path, method, body, true);
    }
    if (!response.ok)
      throw new QQBotApiError(
        `QQ Bot API 请求失败：${method} ${path} HTTP ${response.status}`,
        response.status,
        path,
        responseBody,
      );
    return parseJson<T>(responseBody, path);
  }

  private async fetchWithTimeout(input: string | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJson<T>(body: string, path: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`QQ Bot API ${path} 返回了无效 JSON`);
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function nextMessageSequence() {
  return (Date.now() ^ Math.floor(Math.random() * 65_536)) & 0xffff;
}
