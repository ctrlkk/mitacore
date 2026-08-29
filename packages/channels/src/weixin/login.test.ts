import { describe, expect, test, vi } from "vitest";
import { loginWithQr } from "./login";

describe("loginWithQr", () => {
  test("二维码过期后自动获取新二维码并继续登录", async () => {
    const originalFetch = globalThis.fetch;
    const qrcodeContents: string[] = [];
    let qrcodeCount = 0;

    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = String(input);
      if (url.includes("get_bot_qrcode")) {
        qrcodeCount += 1;
        return json({ qrcode: `qr-${qrcodeCount}`, qrcode_img_content: `content-${qrcodeCount}` });
      }
      if (url.includes("qrcode=qr-1")) return json({ status: "expired" });
      return json({ status: "confirmed", bot_token: "token", ilink_bot_id: "account-id", ilink_user_id: "user-id" });
    });

    try {
      await expect(
        loginWithQr({
          onQrCode: (content) => qrcodeContents.push(content),
          onScanned: () => undefined,
          onVerifyCodeRequired: () => undefined,
          waitForVerifyCode: async () => "",
        }),
      ).resolves.toEqual({ accountId: "account-id", token: "token", userId: "user-id" });

      expect(qrcodeContents).toEqual(["content-1", "content-2"]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
