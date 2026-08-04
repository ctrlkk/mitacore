import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config, type Config } from "@/config";
import type { LanguageModel } from "ai";

type ProviderFn = (modelId: string) => LanguageModel;

const providerCache = new Map<string, ProviderFn>();

function createProvider(cfg: Config["providers"][number]): ProviderFn {
  const { name, type, options } = cfg;
  const common = { apiKey: options.api_key, baseURL: options.base_url };
  switch (type) {
    case "anthropic":
      return createAnthropic({ name, ...common });
    case "openai-responses":
      return createOpenAI({ name, ...common });
    case "openai-compatible":
      return createOpenAICompatible({ name, ...common });
    case "deepseek":
      return createDeepSeek(common);
  }
}

/**
 * 根据模型别名获取模型实例
 * @param alias 在 config.toml 中配置的模型别名
 */
export function getModel(alias: string): LanguageModel {
  for (const providerCfg of config.providers) {
    const modelCfg = providerCfg.models.find((m) => m.alias === alias);
    if (!modelCfg) continue;

    const cacheKey = `${providerCfg.type}:${providerCfg.name}:${providerCfg.options.base_url}`;
    let provider = providerCache.get(cacheKey);
    if (!provider) {
      provider = createProvider(providerCfg);
      providerCache.set(cacheKey, provider);
    }
    return provider(modelCfg.id);
  }
  throw new Error(`未找到别名为 "${alias}" 的模型，请检查 config.toml 配置`);
}

/**
 * 返回别名为 alias 的模型对应的 provider 配置与真实 model id，
 * 用于绕过 AI SDK 直接调用 provider API（如 mimo 的 video_url 扩展）。
 */
export function getModelConfig(alias: string): {
  baseUrl: string;
  apiKey: string;
  modelId: string;
} {
  for (const providerCfg of config.providers) {
    const modelCfg = providerCfg.models.find((m) => m.alias === alias);
    if (modelCfg) {
      return {
        baseUrl: providerCfg.options.base_url,
        apiKey: providerCfg.options.api_key,
        modelId: modelCfg.id,
      };
    }
  }
  throw new Error(`未找到别名为 "${alias}" 的模型，请检查 config.toml 配置`);
}
