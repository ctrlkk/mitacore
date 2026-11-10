import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
  doGenerate: vi.fn(),
  doStream: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: providerMocks.createOpenAI }));

import { config, defaultConfig } from "@/config";
import { getModel, resolveModelAlias } from "./model";

const originalProviders = config.providers;
let providerIndex = 0;

beforeEach(() => {
  providerIndex++;
  providerMocks.createOpenAI.mockReset();
  providerMocks.doGenerate.mockReset();
  providerMocks.doStream.mockReset();
  providerMocks.createOpenAI.mockReturnValue((modelId: string) => ({
    specificationVersion: "v4",
    provider: "test.responses",
    modelId,
    supportedUrls: {},
    doGenerate: providerMocks.doGenerate,
    doStream: providerMocks.doStream,
  }));
});

afterEach(() => {
  config.providers = originalProviders;
});

async function callConfiguredModel(callOptions: Record<string, unknown> = {}) {
  const model = getModel("configured-model");
  if (typeof model === "string" || model.specificationVersion !== "v4") {
    throw new Error("测试模型不是 LanguageModelV4");
  }
  await model.doGenerate(callOptions as Parameters<typeof model.doGenerate>[0]);
  return providerMocks.doGenerate.mock.calls[0]?.[0];
}

describe("resolveModelAlias", () => {
  test("按服务器本地时间匹配时段", () => {
    const now = new Date(2026, 0, 1, 23, 30);
    const modelConfig = {
      models: { ...defaultConfig.models, reply: "default" },
      model_schedule: {
        rules: [{ start: "23:00", end: "01:00", models: { reply: "overnight" } }],
      },
    };

    expect(resolveModelAlias(modelConfig, "reply", now)).toBe("overnight");
  });
});

describe("getModel", () => {
  beforeEach(() => {
    config.providers = [
      {
        name: `OpenAI-${providerIndex}`,
        type: "openai-responses",
        options: {
          base_url: `https://example-${providerIndex}.com/v1`,
          api_key: "test-key",
        },
        models: [
          {
            id: "gpt-test",
            alias: "configured-model",
            options: {
              max_output_tokens: 4096,
              temperature: 0.6,
              top_p: 0.9,
              top_k: 40,
              presence_penalty: 0.1,
              frequency_penalty: -0.1,
              seed: 42,
              reasoning: "high",
              provider_options: { reasoningEffort: "high" },
            },
          },
        ],
      },
    ];
  });

  test("将模型配置转换为 AI SDK 默认参数", async () => {
    const params = await callConfiguredModel();

    expect(params).toMatchObject({
      maxOutputTokens: 4096,
      temperature: 0.6,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: -0.1,
      seed: 42,
      reasoning: "high",
      providerOptions: { openai: { reasoningEffort: "high" } },
    });
  });

  test("调用参数覆盖模型默认参数", async () => {
    const params = await callConfiguredModel({
      temperature: 0.2,
      reasoning: "low",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });

    expect(params).toMatchObject({
      temperature: 0.2,
      reasoning: "low",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
  });
});
