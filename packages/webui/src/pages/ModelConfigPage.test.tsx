import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelConfigPage } from "./ModelConfigPage";

const config = {
  providers: [
    {
      name: "测试供应商",
      type: "openai-compatible",
      options: { base_url: "https://api.example.com/v1", api_key: "secret" },
      models: [{ id: "test-model", alias: "test-model" }],
    },
  ],
  models: {
    plan: "test-model",
    reply: "test-model",
    main: "test-model",
    task_explore: "test-model",
    task_general: "test-model",
    multimodal_image: "test-model",
    multimodal_video: "test-model",
    multimodal_audio: "test-model",
  },
  model_schedule: { rules: [] },
};

function renderPage() {
  return render(
    <TooltipProvider>
      <ModelConfigPage />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelConfigPage", () => {
  it("保存模型默认参数", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/config" && init?.method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ saved: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(config), { headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑供应商 测试供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "配置模型参数 test-model" }));

    expect(await screen.findByRole("heading", { name: "模型参数" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("最大输出 Tokens"), { target: { value: "4096" } });
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.6" } });
    fireEvent.change(screen.getByLabelText("Top P"), { target: { value: "0.9" } });
    fireEvent.change(screen.getByLabelText("停止序列"), { target: { value: "<END>\n\nDONE" } });

    fireEvent.click(screen.getByLabelText("推理强度"));
    fireEvent.click(await screen.findByRole("option", { name: "高 (high)" }));

    const providerOptions = screen.getByLabelText("供应商专属选项");
    fireEvent.change(providerOptions, { target: { value: "[]" } });
    expect(screen.getByText("请输入 JSON 对象")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用参数" })).toBeDisabled();
    fireEvent.change(providerOptions, { target: { value: '{"reasoningEffort":"high"}' } });
    fireEvent.click(screen.getByRole("button", { name: "应用参数" }));

    fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      const [, init] = fetchMock.mock.calls.find(([, requestInit]) => requestInit?.method === "PUT")!;
      const saved = JSON.parse(init!.body as string);
      expect(saved.providers[0]).toMatchObject({
        models: [
          {
            options: {
              max_output_tokens: 4096,
              temperature: 0.6,
              top_p: 0.9,
              reasoning: "high",
              stop_sequences: ["<END>", "DONE"],
              provider_options: { reasoningEffort: "high" },
            },
          },
        ],
      });
    });
  });

  it("清空模型参数后不保留空 options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...config,
            providers: [
              {
                ...config.providers[0],
                models: [{ ...config.providers[0]!.models[0], options: { temperature: 0.8, reasoning: "medium" } }],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑供应商 测试供应商" }));
    expect(screen.getByRole("button", { name: "配置模型参数 test-model" })).toHaveTextContent("参数 · 2");
    fireEvent.click(screen.getByRole("button", { name: "配置模型参数 test-model" }));
    fireEvent.click(await screen.findByRole("button", { name: "清空全部" }));
    fireEvent.click(screen.getByRole("button", { name: "应用参数" }));

    expect(screen.getByRole("button", { name: "配置模型参数 test-model" })).toHaveTextContent("参数");
    expect(screen.getByRole("button", { name: "配置模型参数 test-model" })).not.toHaveTextContent("参数 ·");
  });
});
