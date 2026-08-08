import { describe, expect, test } from "bun:test";
import { QQBotHttpClient } from "./api";
import { QQBotClient, type QQBotWebSocket } from "./client";
import type { QQBotInboundMessage } from "./protocol";

describe("QQBotHttpClient", () => {
  test("获取 token、发现 Gateway 并以被动回复发送文本", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new QQBotHttpClient(
      { appId: "app-id", appSecret: "app-secret" },
      {
        fetch: async (input, init) => {
          const url = String(input);
          requests.push({ url, init });
          if (url.endsWith("/app/getAppAccessToken")) return json({ access_token: "token", expires_in: 7200 });
          if (url.endsWith("/gateway")) return json({ url: "wss://gateway.example" });
          return json({ id: "reply-id", timestamp: "2026-01-01T00:00:00Z" });
        },
      },
    );

    await expect(client.getGatewayUrl()).resolves.toBe("wss://gateway.example");
    await expect(
      client.sendText({ scope: "group", targetId: "group-openid", msgId: "message-id" }, "你好"),
    ).resolves.toMatchObject({
      id: "reply-id",
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://bots.qq.com/app/getAppAccessToken",
      "https://api.sgroup.qq.com/gateway",
      "https://api.sgroup.qq.com/v2/groups/group-openid/messages",
    ]);
    expect(requests[2]?.init?.headers).toMatchObject({ Authorization: "QQBot token" });
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      content: "你好",
      msg_type: 0,
      msg_id: "message-id",
    });
  });

  test("鉴权失败时刷新 token 并重试一次", async () => {
    let tokenRequests = 0;
    let messageRequests = 0;
    const client = new QQBotHttpClient(
      { appId: "app-id", appSecret: "app-secret" },
      {
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/app/getAppAccessToken")) {
            tokenRequests += 1;
            return json({ access_token: `token-${tokenRequests}`, expires_in: 7200 });
          }
          messageRequests += 1;
          return messageRequests === 1 ? new Response("expired", { status: 401 }) : json({ id: "reply-id" });
        },
      },
    );

    await expect(client.sendText({ scope: "c2c", targetId: "user-openid" }, "你好")).resolves.toMatchObject({
      id: "reply-id",
    });
    expect(tokenRequests).toBe(2);
    expect(messageRequests).toBe(2);
  });
});

describe("QQBotClient", () => {
  test("通过 HELLO 识别、READY 就绪并归一化 C2C 消息", async () => {
    const sockets: FakeWebSocket[] = [];
    const messages: QQBotInboundMessage[] = [];
    const client = new QQBotClient(
      { appId: "app-id", appSecret: "app-secret" },
      {
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/app/getAppAccessToken")) return json({ access_token: "token", expires_in: 7200 });
          return json({ url: "wss://gateway.example" });
        },
        webSocketFactory: (url) => {
          expect(url).toBe("wss://gateway.example");
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    );
    client.onMessage((message) => {
      messages.push(message);
    });

    const connecting = client.connect();
    await waitFor(() => sockets.length === 1);
    const socket = sockets[0]!;
    socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
    await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).op === 2));
    expect(socket.sent.map((packet) => JSON.parse(packet).op)).toEqual([1, 2]);

    socket.emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "session-id" } }) });
    await connecting;
    expect(client.isConnected).toBe(true);

    socket.emit("message", {
      data: JSON.stringify({
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        s: 2,
        d: { id: "message-id", content: "hello", author: { user_openid: "user-openid", username: "用户" } },
      }),
    });
    await waitFor(() => messages.length === 1);
    expect(messages[0]).toMatchObject({
      senderId: "user-openid",
      content: "hello",
      replyTarget: { scope: "c2c", targetId: "user-openid", msgId: "message-id" },
    });

    socket.emit("message", {
      data: JSON.stringify({
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        s: 3,
        d: {
          id: "group-message-id",
          content: "群消息",
          group_openid: "group-openid",
          author: { member_openid: "member-openid" },
        },
      }),
    });
    await waitFor(() => messages.length === 2);
    expect(messages[1]).toMatchObject({
      kind: "group",
      senderId: "member-openid",
      replyTarget: { scope: "group", targetId: "group-openid", msgId: "group-message-id" },
    });

    client.close();
  });
});

class FakeWebSocket implements QQBotWebSocket {
  readonly readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  close(code = 1000, reason = "") {
    this.emit("close", { code, reason });
  }

  send(data: string) {
    this.sent.push(data);
  }

  emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("等待条件超时");
}
