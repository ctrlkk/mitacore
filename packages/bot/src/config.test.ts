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
});
