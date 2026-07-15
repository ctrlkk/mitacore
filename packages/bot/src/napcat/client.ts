import { createHash } from "node:crypto";
import { logger } from "@/logger";
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

/** 登录状态响应 data 结构：boolean | { isLogin: boolean } */
export const LoginStatusDataSchema = z.union([z.boolean(), z.object({ isLogin: z.boolean() })]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const resp = await fetch(`http://${conn.host}:${conn.port}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const json = await resp.json();
  const envelope = WebUIEnvelopeSchema.parse(json);
  if (envelope.code !== 0) throw new Error(`API ${path} 失败: ${envelope.message ?? JSON.stringify(json)}`);
  if (dataSchema) return dataSchema.parse(envelope.data);
  return envelope.data as T;
}

async function loginWebUI(port: number, token: string): Promise<WebUIConnection> {
  const hash = createHash("sha256")
    .update(token + ".napcat")
    .digest("hex");

  const candidates = ["127.0.0.1", "localhost"];
  for (const host of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(`http://${host}:${port}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash }),
          signal: AbortSignal.timeout(3000),
        });
        const json = await resp.json();
        const envelope = WebUIEnvelopeSchema.parse(json);
        if (envelope.code === 0) {
          const { Credential } = LoginCredentialSchema.parse(envelope.data);
          return { host, port, credential: Credential };
        }
        logger.warn({ host, attempt: attempt + 1, message: envelope.message }, "WebUI 登录尝试失败");
      } catch {
        logger.warn({ host, attempt: attempt + 1 }, "WebUI 不可达");
      }
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error("所有候选 host 都无法连接 WebUI");
}

/**
 * 登录 WebUI 并创建 API client。
 * @param port - WebUI 端口
 * @param token - WebUI 令牌
 * @returns 包含 getNapCatVersion、checkLoginStatus、setOB11Config 方法的 client 对象
 */
export async function createNapCatApi(port: number, token: string) {
  const conn = await loginWebUI(port, token);

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
     * @returns 是否登录
     */
    async checkLoginStatus(): Promise<boolean> {
      try {
        const data = await webuiFetch(conn, "POST", "/api/QQLogin/CheckLoginStatus", {
          dataSchema: LoginStatusDataSchema,
        });
        if (typeof data === "boolean") return data;
        return data.isLogin;
      } catch {
        return false;
      }
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
