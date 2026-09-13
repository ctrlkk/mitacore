import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, test, vi } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import { DoubaoTtsClient } from "./doubao";

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: Buffer[] = [];

  open(logId = "log-1") {
    this.readyState = WebSocket.OPEN;
    this.emit("upgrade", { headers: { "x-tt-logid": logId } } as unknown as IncomingMessage);
    this.emit("open");
  }

  send(data: Buffer, _options: { binary: boolean }, callback: (error?: Error) => void) {
    this.sent.push(Buffer.from(data));
    callback();
  }

  close(code = 1000, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.readyState = WebSocket.CLOSED;
  }

  receive(frame: Buffer) {
    this.emit("message", frame, true);
  }
}

function createFactory() {
  const sockets: FakeWebSocket[] = [];
  const options: ClientOptions[] = [];
  const factory = vi.fn((_url: string, socketOptions: ClientOptions) => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    options.push(socketOptions);
    queueMicrotask(() => socket.open());
    return socket as unknown as WebSocket;
  });
  return { factory, sockets, options };
}

function createEventFrame(messageType: number, event: number, payload: Buffer, sessionId = "session-1") {
  const session = Buffer.from(sessionId);
  const frame = Buffer.alloc(4 + 4 + 4 + session.length + 4 + payload.length);
  frame.set([0x11, (messageType << 4) | 0x4, messageType === 0xb ? 0x00 : 0x10, 0x00], 0);
  frame.writeInt32BE(event, 4);
  frame.writeUInt32BE(session.length, 8);
  session.copy(frame, 12);
  frame.writeUInt32BE(payload.length, 12 + session.length);
  payload.copy(frame, 16 + session.length);
  return frame;
}

function createErrorFrame(code: number, message: string) {
  const payload = Buffer.from(message);
  const frame = Buffer.alloc(12 + payload.length);
  frame.set([0x11, 0xf0, 0x10, 0x00], 0);
  frame.writeUInt32BE(code, 4);
  frame.writeUInt32BE(payload.length, 8);
  payload.copy(frame, 12);
  return frame;
}

describe("DoubaoTtsClient", () => {
  test("发送 V3 请求并流式收集音频", async () => {
    const { factory, sockets, options } = createFactory();
    const onAudioChunk = vi.fn();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    const resultPromise = client.synthesize("你好", {
      speaker: "test-speaker",
      format: "pcm",
      speechRate: 10,
      contextTexts: ["请用轻松、自然的语气说话。"],
      ssml: "<speak>你好</speak>",
      additions: { disable_markdown_filter: true },
      onAudioChunk,
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    expect(options[0]?.headers).toMatchObject({
      "X-Api-Key": "test-key",
      "X-Api-Resource-Id": "seed-tts-2.0",
      "X-Control-Require-Usage-Tokens-Return": "*",
    });
    expect(options[0]?.headers?.["X-Api-Request-Id"]).toEqual(expect.any(String));

    const requestFrame = sockets[0]!.sent[0]!;
    expect(requestFrame.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x10, 0x10, 0x00]));
    expect(requestFrame.readUInt32BE(4)).toBe(requestFrame.length - 8);
    expect(JSON.parse(requestFrame.subarray(8).toString())).toEqual({
      req_params: {
        text: "你好",
        speaker: "test-speaker",
        audio_params: { format: "pcm", sample_rate: 24000, speech_rate: 10 },
        context_texts: ["请用轻松、自然的语气说话。"],
        ssml: "<speak>你好</speak>",
        additions: '{"disable_markdown_filter":true}',
      },
    });

    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([1, 2])));
    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([3, 4])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from('{"usage":{"text_words":2}}')));

    const result = await resultPromise;
    expect(onAudioChunk).toHaveBeenNthCalledWith(1, new Uint8Array([1, 2]));
    expect(onAudioChunk).toHaveBeenNthCalledWith(2, new Uint8Array([3, 4]));
    expect(result.audio.type).toBe("audio/pcm");
    expect(new Uint8Array(await result.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result).toMatchObject({ logId: "log-1", sessionId: "session-1", textWords: 2 });
  });

  test("串行合成时复用同一连接", async () => {
    const { factory, sockets } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    const first = client.synthesize("第一段", { speaker: "test-speaker" });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([1])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from("{}")));
    await first;

    const second = client.synthesize("第二段", { speaker: "test-speaker" });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(2));
    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([2])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from("{}")));
    await second;

    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("使用表现力增强版复刻音色引用上下文", async () => {
    const { factory, sockets, options } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key", resourceId: "seed-icl-2.0" }, factory);

    const result = client.synthesize("こんにちは", {
      speaker: "S_testSpeaker",
      model: "seed-tts-2.0-expressive",
      toneFidelity: true,
      contextTexts: ["友達との再会を喜んでいます。"],
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    expect(options[0]?.headers?.["X-Api-Resource-Id"]).toBe("seed-icl-2.0");
    expect(JSON.parse(sockets[0]!.sent[0]!.subarray(8).toString())).toMatchObject({
      req_params: {
        speaker: "S_testSpeaker",
        model: "seed-tts-2.0-expressive",
        tone_fidelity: true,
        context_texts: ["友達との再会を喜んでいます。"],
      },
    });

    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([1])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from("{}")));
    await result;
  });

  test("将服务端错误帧转换为异常并丢弃连接", async () => {
    const { factory, sockets } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    const result = client.synthesize("你好", { speaker: "test-speaker" });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0]!.receive(createErrorFrame(45002001, "No readable text!"));

    await expect(result).rejects.toThrow("45002001 No readable text!");
    expect(sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  });

  test("使用 Zod 拒绝无效的会话结束响应", async () => {
    const { factory, sockets } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    const result = client.synthesize("你好", { speaker: "test-speaker" });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([1])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from('{"usage":{"text_words":"2"}}')));

    await expect(result).rejects.toThrow("expected number");
    expect(sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  });

  test("拒绝空文本和空音色", async () => {
    const { factory } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    await expect(client.synthesize("   ", { speaker: "test-speaker" })).rejects.toThrow("待合成文本不能为空");
    await expect(client.synthesize("你好", { speaker: "" })).rejects.toThrow("音色 ID 不能为空");
    expect(factory).not.toHaveBeenCalled();
  });

  test("将标准版复刻音色的上下文交给服务端处理", async () => {
    const { factory, sockets } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    const result = client.synthesize("你好", {
      speaker: "test-speaker",
      model: "seed-tts-2.0-standard",
      contextTexts: ["我今天遇到了一件开心的事。"],
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    expect(JSON.parse(sockets[0]!.sent[0]!.subarray(8).toString())).toMatchObject({
      req_params: {
        model: "seed-tts-2.0-standard",
        context_texts: ["我今天遇到了一件开心的事。"],
      },
    });

    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([1])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from("{}")));
    await result;
  });

  test("握手期间可以取消", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn(() => socket as unknown as WebSocket);
    const controller = new AbortController();
    const client = new DoubaoTtsClient({ apiKey: "test-key" }, factory);

    const result = client.synthesize("你好", { speaker: "test-speaker", signal: controller.signal });
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    controller.abort(new Error("用户取消"));

    await expect(result).rejects.toThrow("用户取消");
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  test("等待异步音频分片处理时仍受超时限制", async () => {
    const { factory, sockets } = createFactory();
    const client = new DoubaoTtsClient({ apiKey: "test-key", timeoutMs: 20 }, factory);

    const result = client.synthesize("你好", {
      speaker: "test-speaker",
      onAudioChunk: () => new Promise(() => undefined),
    });
    const rejection = expect(result).rejects.toThrow("合成超时");
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0]!.receive(createEventFrame(0xb, 352, Buffer.from([1])));
    sockets[0]!.receive(createEventFrame(0x9, 152, Buffer.from("{}")));

    await rejection;
  });
});
