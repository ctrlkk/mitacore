import type { WeixinCredentials } from "./protocol";
import { sleep } from "shared/time";

const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";

function loginHeaders() {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 6),
  };
}

async function loginRequest<T>(endpoint: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const response = await fetch(new URL(endpoint, `${LOGIN_BASE_URL}/`), {
    method,
    headers: loginHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`微信登录接口 ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

export type WeixinQrLoginEvents = {
  onQrCode(content: string): void;
  onScanned(): void;
  onVerifyCodeRequired(): void;
  waitForVerifyCode(): Promise<string>;
};

export async function loginWithQr(events: WeixinQrLoginEvents, localToken?: string): Promise<WeixinCredentials> {
  const qr = await loginRequest<{ qrcode: string; qrcode_img_content: string }>(
    "ilink/bot/get_bot_qrcode?bot_type=3",
    "POST",
    { local_token_list: localToken ? [localToken] : [] },
  );
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("微信登录接口未返回二维码");

  events.onQrCode(qr.qrcode_img_content);
  let verifyCode: string | undefined;
  let pollingBaseUrl = LOGIN_BASE_URL;
  const deadline = Date.now() + 8 * 60_000;

  while (Date.now() < deadline) {
    const query = new URLSearchParams({ qrcode: qr.qrcode });
    if (verifyCode) query.set("verify_code", verifyCode);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetch(new URL(`ilink/bot/get_qrcode_status?${query}`, `${pollingBaseUrl}/`), {
        headers: loginHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`二维码状态接口 HTTP ${response.status}`);
      const status = (await response.json()) as {
        status: string;
        bot_token?: string;
        ilink_bot_id?: string;
        ilink_user_id?: string;
        redirect_host?: string;
      };

      if (status.status === "scaned") {
        verifyCode = undefined;
        events.onScanned();
      } else if (status.status === "need_verifycode") {
        events.onVerifyCodeRequired();
        verifyCode = await events.waitForVerifyCode();
      } else if (status.status === "scaned_but_redirect" && status.redirect_host) {
        pollingBaseUrl = `https://${status.redirect_host}`;
      } else if (status.status === "confirmed") {
        if (!status.bot_token || !status.ilink_bot_id) throw new Error("微信确认登录后未返回完整凭证");
        const credentials: WeixinCredentials = {
          accountId: status.ilink_bot_id,
          token: status.bot_token,
          userId: status.ilink_user_id,
        };
        return credentials;
      } else if (status.status === "binded_redirect") {
        throw new Error("微信账号已绑定，但配置中没有可用凭证，请删除旧绑定后重试");
      } else if (["expired", "verify_code_blocked"].includes(status.status)) {
        throw new Error(status.status === "expired" ? "微信登录二维码已过期" : "微信验证码尝试次数过多");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await sleep(1_000);
  }
  throw new Error("微信扫码登录超时");
}
