import { describe, expect, it } from "vitest";
import { validateConfig } from "@/config";

describe("配置校验", () => {
  it("默认只接收 OneBot 图片消息", () => {
    const config = validateConfig({});

    expect(config.napcat).toMatchObject({
      receive_image: true,
      receive_video: false,
      receive_audio: false,
    });
  });

  it("允许单独关闭 OneBot 媒体消息", () => {
    const config = validateConfig({
      napcat: {
        receive_image: false,
        receive_video: false,
        receive_audio: false,
      },
    });

    expect(config.napcat).toMatchObject({
      receive_image: false,
      receive_video: false,
      receive_audio: false,
    });
  });

  it("接受 Google Gemini 原生供应商", () => {
    const config = validateConfig({
      providers: [
        {
          name: "Google Gemini",
          type: "google",
          options: {
            base_url: "https://generativelanguage.googleapis.com/v1beta",
            api_key: "test-key",
          },
          models: [{ id: "gemini-3.8-flash", alias: "gemini" }],
        },
      ],
    });

    expect(config.providers[0]).toMatchObject({
      name: "Google Gemini",
      type: "google",
      models: [{ id: "gemini-3.8-flash", alias: "gemini" }],
    });
  });

  it("接受供应商超时和模型默认选项", () => {
    const config = validateConfig({
      providers: [
        {
          name: "OpenAI",
          type: "openai-responses",
          options: {
            base_url: "https://api.openai.com/v1",
            api_key: "test-key",
            timeout: 300_000,
          },
          models: [
            {
              id: "gpt-test",
              alias: "gpt-test",
              options: {
                max_output_tokens: 4096,
                temperature: 0.6,
                top_p: 0.9,
                top_k: 40,
                presence_penalty: 0.1,
                frequency_penalty: -0.1,
                stop_sequences: ["</answer>"],
                seed: 42,
                reasoning: "high",
                provider_options: {
                  reasoningEffort: "high",
                  metadata: { source: "config", tags: ["test", 1, true] },
                },
              },
            },
          ],
        },
      ],
    });

    expect(config.providers[0]?.options.timeout).toBe(300_000);
    expect(config.providers[0]?.models[0]?.options).toEqual({
      max_output_tokens: 4096,
      temperature: 0.6,
      top_p: 0.9,
      top_k: 40,
      presence_penalty: 0.1,
      frequency_penalty: -0.1,
      stop_sequences: ["</answer>"],
      seed: 42,
      reasoning: "high",
      provider_options: {
        reasoningEffort: "high",
        metadata: { source: "config", tags: ["test", 1, true] },
      },
    });
  });

  it.each([0, -1])("允许使用 %s 禁用供应商请求超时", (timeout) => {
    const config = validateConfig({
      providers: [
        {
          name: "DeepSeek",
          type: "deepseek",
          options: {
            base_url: "https://api.deepseek.com",
            api_key: "test-key",
            timeout,
          },
          models: [{ id: "deepseek-chat", alias: "deepseek" }],
        },
      ],
    });

    expect(config.providers[0]?.options.timeout).toBe(timeout);
  });

  it.each([1.5, false])("拒绝无效的供应商请求超时 %s", (timeout) => {
    expect(() =>
      validateConfig({
        providers: [
          {
            name: "DeepSeek",
            type: "deepseek",
            options: {
              base_url: "https://api.deepseek.com",
              api_key: "test-key",
              timeout,
            },
            models: [{ id: "deepseek-chat", alias: "deepseek" }],
          },
        ],
      }),
    ).toThrow("配置校验失败");
  });

  it("拒绝未声明的模型通用选项", () => {
    expect(() =>
      validateConfig({
        providers: [
          {
            name: "DeepSeek",
            type: "deepseek",
            options: {
              base_url: "https://api.deepseek.com",
              api_key: "test-key",
            },
            models: [{ id: "deepseek-chat", alias: "deepseek", options: { temprature: 0.5 } }],
          },
        ],
      }),
    ).toThrow("配置校验失败");
  });
});
