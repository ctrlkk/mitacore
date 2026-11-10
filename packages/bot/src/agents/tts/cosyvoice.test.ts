import { afterEach, describe, expect, test, vi } from "vitest";
import { synthesizeCosyVoice } from "./cosyvoice";

afterEach(() => vi.unstubAllGlobals());

describe("synthesizeCosyVoice", () => {
  test("使用业务空间端点合成并下载返回的音频", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          request_id: "request-1",
          usage: { characters: 4 },
          output: { audio: { url: "https://example.test/audio.mp3" } },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeCosyVoice("你好呀", {
      apiKey: "sk-test",
      workspaceId: "llm-example",
      voiceId: "cosyvoice-v3.5-plus-xianhuja-example",
      languageHints: ["ja"],
      instruction: "用温柔的语气说话",
      rate: 0.9,
      seed: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://llm-example.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      model: "cosyvoice-v3.5-plus",
      input: {
        text: "你好呀",
        voice: "cosyvoice-v3.5-plus-xianhuja-example",
        language_hints: ["ja"],
        instruction: "用温柔的语气说话",
        rate: 0.9,
        seed: 0,
      },
    });
    expect(result.requestId).toBe("request-1");
    expect(result.characters).toBe(4);
    expect(result.audio.type).toBe("audio/mpeg");
    expect(new Uint8Array(await result.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("拒绝空文本", async () => {
    await expect(
      synthesizeCosyVoice("   ", { apiKey: "sk-test", workspaceId: "llm-example", voiceId: "voice-example" }),
    ).rejects.toThrow("待合成文本不能为空");
  });

  test("拒绝不符合文档结构的成功响应", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ output: { audio: { url: 123 } } })));

    await expect(
      synthesizeCosyVoice("你好呀", { apiKey: "sk-test", workspaceId: "llm-example", voiceId: "voice-example" }),
    ).rejects.toThrow("Invalid input");
  });
});
