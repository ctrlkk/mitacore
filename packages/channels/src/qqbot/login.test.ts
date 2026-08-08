import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { startQQBotQrLogin } from "./login";

describe("startQQBotQrLogin", () => {
  test("二维码过期后重建任务，并返回本地解密的凭证", async () => {
    const qrUrls: string[] = [];
    const keys = new Map<string, string>();
    let taskCount = 0;
    const credentials = await new Promise<{ appId: string; appSecret: string; userOpenid?: string }>(
      (resolve, reject) => {
        startQQBotQrLogin(
          {
            onQrUrl: (url) => qrUrls.push(url),
            onExpired: () => undefined,
            onSuccess: resolve,
            onError: reject,
          },
          {
            pollIntervalMs: 0,
            fetch: async (input, init) => {
              const url = String(input);
              const body = JSON.parse(String(init?.body)) as { key?: string; task_id?: string };
              if (url.endsWith("/create_bind_task")) {
                taskCount += 1;
                const taskId = `task-${taskCount}`;
                keys.set(taskId, body.key!);
                return json({ retcode: 0, data: { task_id: taskId } });
              }
              if (body.task_id === "task-1") return json({ retcode: 0, data: { status: 3 } });
              return json({
                retcode: 0,
                data: {
                  status: 2,
                  bot_appid: "app-id",
                  bot_encrypt_secret: encrypt("app-secret", keys.get("task-2")!),
                  user_openid: "user-openid",
                },
              });
            },
          },
        );
      },
    );

    expect(credentials).toEqual({ appId: "app-id", appSecret: "app-secret", userOpenid: "user-openid" });
    expect(qrUrls).toEqual([
      "https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-1&source=agents-bot&_wv=2",
      "https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-2&source=agents-bot&_wv=2",
    ]);
  });

  test("取消后结束轮询且不泄露任务密钥", async () => {
    const error = await new Promise<Error>((resolve) => {
      let cancel: () => void = () => undefined;
      cancel = startQQBotQrLogin(
        {
          onQrUrl: () => cancel(),
          onSuccess: () => {
            throw new Error("不应授权成功");
          },
          onError: resolve,
        },
        {
          fetch: async () => json({ retcode: 0, data: { task_id: "task-secret-value" } }),
        },
      );
    });

    expect(error.message).toBe("QQ Bot 扫码授权已取消");
    expect(error.message).not.toContain("task-secret-value");
  });
});

function encrypt(plaintext: string, encodedKey: string) {
  const key = Buffer.from(encodedKey, "base64");
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
