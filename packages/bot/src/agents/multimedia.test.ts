import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getModelConfigForRole: vi.fn(),
  getModelForRole: vi.fn(),
  resolveModelAlias: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("./model", () => ({
  getModelConfigForRole: mocks.getModelConfigForRole,
  getModelForRole: mocks.getModelForRole,
  resolveModelAlias: mocks.resolveModelAlias,
}));

import { videoToText } from "./multimedia";

describe("videoToText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModelAlias.mockReturnValue("gemini-video");
    mocks.getModelConfigForRole.mockReturnValue({
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "test-key",
      modelId: "gemini-3.8-flash",
    });
    mocks.getModelForRole.mockReturnValue({ modelId: "gemini-3.8-flash" });
    mocks.generateText.mockResolvedValue({ text: "视频描述" });
  });

  it("通过 Google 原生模型理解视频", async () => {
    const result = await videoToText(new Blob(["video"], { type: "video/mp4" }));

    expect(result).toBe("视频描述");
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: "gemini-3.8-flash" },
        messages: [
          {
            role: "user",
            content: [
              expect.objectContaining({ type: "file", mediaType: "video/mp4", data: expect.any(ArrayBuffer) }),
              { type: "text", text: "解释视频" },
            ],
          },
        ],
      }),
    );
  });
});
