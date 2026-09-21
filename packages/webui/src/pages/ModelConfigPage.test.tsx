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
  context: {
    plan: { max_tokens: 108000 },
    reply: { max_tokens: 108000 },
    main: { max_tokens: 108000 },
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
  it("默认聚焦核心流程，并可展开和保存专用模型", async () => {
    const configWithSpecializedModel = {
      ...config,
      providers: [
        {
          ...config.providers[0],
          models: [...config.providers[0].models, { id: "special-model", alias: "special-model" }],
        },
      ],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/config" && init?.method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ saved: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(configWithSpecializedModel), { headers: { "content-type": "application/json" } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByRole("combobox", { name: "规划模型" })).toHaveValue("test-model");
    expect(screen.getByRole("combobox", { name: "回复模型" })).toHaveValue("test-model");
    expect(screen.getByRole("combobox", { name: "主代理模型" })).toHaveValue("test-model");
    expect(screen.queryByRole("combobox", { name: "探索子代理模型" })).not.toBeInTheDocument();

    const specializedModelsTrigger = screen.getByRole("button", { name: /专用模型/ });
    fireEvent.click(specializedModelsTrigger);

    expect(screen.getByRole("combobox", { name: "探索子代理模型" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "图像理解模型" })).toBeInTheDocument();

    const generalAgentModel = screen.getByRole("combobox", { name: "通用子代理模型" });
    fireEvent.keyDown(generalAgentModel, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "special-model" }));
    expect(generalAgentModel).toHaveValue("special-model");

    fireEvent.click(specializedModelsTrigger);
    expect(screen.queryByRole("combobox", { name: "通用子代理模型" })).not.toBeInTheDocument();
    fireEvent.click(specializedModelsTrigger);
    expect(screen.getByRole("combobox", { name: "通用子代理模型" })).toHaveValue("special-model");

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      const [, init] = fetchMock.mock.calls.find(([, requestInit]) => requestInit?.method === "PUT")!;
      expect(JSON.parse(init!.body as string).models.task_general).toBe("special-model");
    });
  });

  it("保存各层的上下文管理策略", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/config" && init?.method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ saved: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(config), { headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.change(await screen.findByLabelText("规划层上下文窗口"), { target: { value: "100000" } });
    fireEvent.change(screen.getByLabelText("回复层上下文窗口"), { target: { value: "90000" } });
    fireEvent.change(screen.getByLabelText("主代理上下文窗口"), { target: { value: "80000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      const [, init] = fetchMock.mock.calls.find(([, requestInit]) => requestInit?.method === "PUT")!;
      expect(JSON.parse(init!.body as string).context).toEqual({
        plan: { max_tokens: 100000 },
        reply: { max_tokens: 90000 },
        main: { max_tokens: 80000 },
      });
    });
  });

  it("上下文 token 配置无效时禁止保存", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(config), { headers: { "content-type": "application/json" } })),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText("规划层上下文窗口"), {
      target: { value: "31999" },
    });

    expect(screen.getByText("上下文窗口不能小于 32,000 Tokens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  });

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
    expect(screen.queryByLabelText("供应商专属选项")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("最大输出 Tokens"), { target: { value: "4096" } });
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.6" } });
    expect(screen.queryByLabelText("Top P")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /高级参数/ }));
    const providerOptions = screen.getByLabelText("供应商专属选项");
    expect(screen.getByText("填写传递给模型供应商的 JSON 对象，字段名保持供应商原始格式。")).toBeInTheDocument();
    fireEvent.change(providerOptions, { target: { value: "[]" } });
    expect(screen.getByText("请输入 JSON 对象")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用参数" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /高级参数/ })).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(providerOptions, { target: { value: '{"reasoningEffort":"high"}' } });
    fireEvent.change(screen.getByLabelText("Top P"), { target: { value: "0.9" } });
    expect(screen.getByRole("button", { name: /高级参数/ })).toHaveTextContent("已设置 2 项");
    fireEvent.click(screen.getByRole("button", { name: /高级参数/ }));
    fireEvent.click(screen.getByRole("button", { name: /高级参数/ }));
    expect(screen.getByLabelText("Top P")).toHaveValue(0.9);

    fireEvent.click(screen.getByLabelText("推理强度"));
    fireEvent.click(await screen.findByRole("option", { name: "高 (high)" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "恢复默认" }));
    fireEvent.click(screen.getByRole("button", { name: "应用参数" }));

    expect(screen.getByRole("button", { name: "配置模型参数 test-model" })).toHaveTextContent("参数");
    expect(screen.getByRole("button", { name: "配置模型参数 test-model" })).not.toHaveTextContent("参数 ·");
  });
});
