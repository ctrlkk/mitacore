import { afterEach, describe, expect, test, vi } from "vitest";
import { createNapCatApi } from "./client.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createNapCatApi", () => {
  test("WebUI 凭证过期后只重新登录一次并重试并发请求", async () => {
    let loginCount = 0;
    const authorizationHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/login")) {
          loginCount += 1;
          return json({
            code: 0,
            data: { Credential: loginCount === 1 ? "expired-credential" : "fresh-credential" },
          });
        }

        if (url.endsWith("/api/QQLogin/CheckLoginStatus")) {
          const authorization = new Headers(init?.headers).get("Authorization") ?? "";
          authorizationHeaders.push(authorization);
          if (authorization === "Bearer expired-credential") {
            return json({ code: -1, message: "Unauthorized" });
          }
          return json({ code: 0, data: { isLogin: true, isOffline: false } });
        }

        throw new Error(`未处理的请求: ${url}`);
      }),
    );

    const api = await createNapCatApi(6099, "webui-token");
    const statuses = await Promise.all([api.getLoginStatus(), api.getLoginStatus()]);

    expect(statuses).toEqual([
      { isLoggedIn: true, isOffline: false, qrcodeContent: undefined, loginError: undefined },
      { isLoggedIn: true, isOffline: false, qrcodeContent: undefined, loginError: undefined },
    ]);
    expect(loginCount).toBe(2);
    expect(authorizationHeaders).toEqual([
      "Bearer expired-credential",
      "Bearer expired-credential",
      "Bearer fresh-credential",
      "Bearer fresh-credential",
    ]);
    expect(api.conn.credential).toBe("fresh-credential");
  });

  test("保留不含 data 的 API 错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/auth/login")) {
          return json({ code: 0, data: { Credential: "credential" } });
        }
        return json({ code: -1, message: "Not Login" });
      }),
    );

    const api = await createNapCatApi(6099, "webui-token");

    await expect(api.getLoginStatus()).rejects.toThrow(
      "POST /api/QQLogin/CheckLoginStatus 失败 (HTTP 200, API -1): Not Login",
    );
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
