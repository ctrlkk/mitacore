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
export const LoginStatusDataSchema = z.union([
  z.boolean(),
  z.object({ isLogin: z.boolean() }),
]);
