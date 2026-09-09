import { createHash } from "node:crypto";
import { noopLogger, type NapCatLogger } from "./logger.ts";
import { z } from "zod";

/** WebUI 连接信息 */
export interface WebUIConnection {
  host: string;
  port: number;
  credential: string;
}

/** NapCat WebUI API 响应外层结构：{ code, message?, data } */
export const WebUIEnvelopeSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.unknown(),
});

/** 登录响应 data 结构：{ Credential: string } */
export const LoginCredentialSchema = z.object({
  Credential: z.string(),
});

/** 版本查询响应 data 结构：{ version: string } */
export const VersionDataSchema = z.object({
  version: z.string(),
});

/** 登录状态响应 data 结构。旧版 NapCat 仅返回 boolean。 */
export const LoginStatusDataSchema = z.union([
  z.boolean(),
  z.object({
    isLogin: z.boolean(),
    isOffline: z.boolean().optional(),
    qrcodeurl: z.string().nullish(),
    loginError: z.string().nullish(),
  }),
]);

export const LoginQrcodeDataSchema = z.object({ qrcode: z.string().min(1) });
export const OB11ConfigSchema = z.record(z.string(), z.unknown());

export type NapCatLoginStatus = {
  isLoggedIn: boolean;
  isOffline?: boolean;
  qrcodeContent?: string;
  loginError?: string;
};

class NapCatApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NapCatApiError";
  }
}

function describeNapCatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&](?:token|credential|authorization|sig|password)=)[^&\s]+/gi, "$1***")
    .replace(/(Bearer\s+)\S+/gi, "$1***")
    .slice(0, 300);
}

/**
 * 底层 fetch 封装：自动带 Authorization、zod 验证外层 code+data
 * @param conn - WebUI 连接凭证
 * @param method - HTTP 方法
 * @param path - API 路径
 * @param options - 请求选项
 * @returns 响应数据
 * @throws {Error} - API 调用失败
 */
async function webuiFetch<T>(
  conn: WebUIConnection,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    dataSchema?: z.ZodType<T>;
    noAuth?: boolean;
    timeoutMs?: number;
  },
): Promise<T> {
  const { body, dataSchema, noAuth, timeoutMs = 5000 } = options ?? {};
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!noAuth) headers["Authorization"] = `Bearer ${conn.credential}`;

  let resp: Response;
  try {
    resp = await fetch(`http://${conn.host}:${conn.port}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new NapCatApiError(`${method} ${path} 请求失败: ${describeNapCatError(error)}`);
  }

  const responseText = await resp.text();
  let json: unknown;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new NapCatApiError(`${method} ${path} 返回非 JSON 响应 (HTTP ${resp.status})`);
  }
  const envelope = WebUIEnvelopeSchema.safeParse(json);
  if (!envelope.success) throw new NapCatApiError(`${method} ${path} 返回格式不正确 (HTTP ${resp.status})`);
  if (!resp.ok || envelope.data.code !== 0) {
    throw new NapCatApiError(
      `${method} ${path} 失败 (HTTP ${resp.status}, API ${envelope.data.code}): ${envelope.data.message ?? "未知错误"}`,
    );
  }
  if (dataSchema) return dataSchema.parse(envelope.data.data);
  return envelope.data.data as T;
}

async function loginWebUI(port: number, token: string, timeoutMs: number): Promise<WebUIConnection> {
  const hash = createHash("sha256")
    .update(token + ".napcat")
    .digest("hex");

  const host = "127.0.0.1";
  try {
    const resp = await fetch(`http://${host}:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseText = await resp.text();
    const envelope = WebUIEnvelopeSchema.safeParse(JSON.parse(responseText));
    if (!envelope.success) throw new NapCatApiError(`WebUI 登录响应格式不正确 (HTTP ${resp.status})`);
    if (envelope.data.code === 0) {
      const { Credential } = LoginCredentialSchema.parse(envelope.data.data);
      return { host, port, credential: Credential };
    }
    throw new NapCatApiError(
      `WebUI 登录失败 (HTTP ${resp.status}, API ${envelope.data.code}): ${envelope.data.message ?? "未知错误"}`,
    );
  } catch (error) {
    throw new NapCatApiError(`无法登录 NapCat WebUI：${describeNapCatError(error)}`);
  }
}

/**
 * 登录 WebUI 并创建 API client。
 * @param port - WebUI 端口
 * @param token - WebUI 令牌
 * @param timeoutMs - 等待 WebUI 监听的最大时长
 * @returns 包含 WebUI 版本、QQ 登录及 OneBot 配置方法的 client 对象
 */
export async function createNapCatApi(
  port: number,
  token: string,
  _logger: NapCatLogger = noopLogger,
  timeoutMs = 30_000,
) {
  const conn = await loginWebUI(port, token, timeoutMs);

  return {
    conn,
    /**
     * 获取 NapCat 版本号
     * @returns NapCat 版本号
     */
    async getNapCatVersion(): Promise<string> {
      return await webuiFetch(conn, "GET", "/api/base/GetNapCatVersion", {
        dataSchema: VersionDataSchema,
      }).then((d) => d.version);
    },

    /**
     * 检查登录状态
     * @returns 登录状态与当前二维码内容
     */
    async getLoginStatus(): Promise<NapCatLoginStatus> {
      const data = await webuiFetch(conn, "POST", "/api/QQLogin/CheckLoginStatus", {
        dataSchema: LoginStatusDataSchema,
      });
      if (typeof data === "boolean") return { isLoggedIn: data };
      return {
        isLoggedIn: data.isLogin,
        isOffline: data.isOffline === true,
        qrcodeContent: data.qrcodeurl ?? undefined,
        loginError: data.loginError ?? undefined,
      };
    },

    /** 获取 QQ 登录二维码内容。 */
    async getQQLoginQrcode(): Promise<string> {
      return await webuiFetch(conn, "POST", "/api/QQLogin/GetQQLoginQrcode", {
        dataSchema: LoginQrcodeDataSchema,
      }).then((data) => data.qrcode);
    },

    /** 获取当前 QQ 账号的 OB11 配置。 */
    async getOB11Config(): Promise<Record<string, unknown>> {
      return await webuiFetch(conn, "POST", "/api/OB11Config/GetConfig", {
        dataSchema: OB11ConfigSchema,
      });
    },

    /**
     * 设置 OB11 配置
     * @param config - OB11 配置 JSON 字符串
     */
    async setOB11Config(config: Record<string, unknown>): Promise<void> {
      await webuiFetch(conn, "POST", "/api/OB11Config/SetConfig", {
        body: { config: JSON.stringify(config) },
      });
    },
  };
}

/**
 * 发送重启指令。无需凭证，用于 stopNapcat 在进程关闭前触发优雅退出。
 * @param host - 目标地址（如 127.0.0.1）
 * @param port - WebUI 端口
 */
export async function restartNapcatApi(host: string, port: number): Promise<void> {
  try {
    await fetch(`http://${host}:${port}/api/QQLogin/RestartNapCat`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}
