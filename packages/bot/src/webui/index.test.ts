import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index";

describe("POST /api/models", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("使用 Google API Key 获取并规范化 Gemini 模型 ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        models: [{ name: "models/gemini-3.8-flash" }, { name: "models/gemini-3.5-flash-lite" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createApp().request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "google",
        base_url: "https://generativelanguage.googleapis.com/v1beta/",
        api_key: "test-key",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: ["gemini-3.5-flash-lite", "gemini-3.8-flash"] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("test-key");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });
});
