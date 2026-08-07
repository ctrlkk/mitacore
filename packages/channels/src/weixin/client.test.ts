import { expect, test } from "bun:test";
import { WeixinClient } from "./client";

function createClient() {
  return new WeixinClient(
    { accountId: "bot-id", token: "token" },
    {
      async load() {
        return "";
      },
      async save() {},
    },
  );
}

test("回复从原始 iLink 消息读取目标用户和上下文令牌", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  }) as typeof fetch;

  try {
    await createClient().reply({ from_user_id: "user-id", context_token: "context-token" }, "你好");
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
  expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({
    msg: {
      to_user_id: "user-id",
      context_token: "context-token",
      item_list: [{ text_item: { text: "你好" } }],
    },
  });
});

test("缺少发送者 ID 的原始消息不能用于回复", async () => {
  await expect(createClient().reply({}, "你好")).rejects.toThrow("微信消息缺少发送者 ID，无法回复");
});
