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
});
