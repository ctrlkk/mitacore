import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { config, type Config, type ModelRole } from "@/config";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

type LanguageModelInstance = Exclude<LanguageModel, string>;
type ProviderFn = (modelId: string) => LanguageModelInstance;
type ProviderType = Config["providers"][number]["type"];
type ProviderModel = Config["providers"][number]["models"][number];

const providerOptionsKey: Record<ProviderType, string> = {
  anthropic: "anthropic",
  google: "google",
  "openai-responses": "openai",
  "openai-compatible": "openaiCompatible",
  deepseek: "deepseek",
};

const providerCache = new Map<string, ProviderFn>();

function timeMatchesRule(start: string, end: string, currentTime: string): boolean {
  if (start < end) return currentTime >= start && currentTime < end;
  return currentTime >= start || currentTime < end;
}

/** 根据服务器本地时段解析指定职责实际使用的模型别名。 */
export function resolveModelAlias(
  modelConfig: Pick<Config, "models" | "model_schedule">,
  role: ModelRole,
  now = new Date(),
): string {
  const { model_schedule: schedule } = modelConfig;
  const currentTime = now.toTimeString().slice(0, 5);
  return schedule.rules.reduce((alias, rule) => {
    if (!timeMatchesRule(rule.start, rule.end, currentTime)) return alias;
    return rule.models[role] ?? alias;
  }, modelConfig.models[role]);
}

function createProvider(cfg: Config["providers"][number]): ProviderFn {
  const { name, type, options } = cfg;
  const common = { apiKey: options.api_key, baseURL: options.base_url };
  switch (type) {
    case "anthropic":
      return createAnthropic({ name, ...common });
    case "google":
      return createGoogle({ name, ...common });
    case "openai-responses":
      return createOpenAI({ name, ...common });
    case "openai-compatible":
      return createOpenAICompatible({ name, ...common });
    case "deepseek":
      return createDeepSeek(common);
  }
}

function applyModelOptions(
  model: LanguageModelInstance,
  type: ProviderType,
  options: ProviderModel["options"],
): LanguageModelInstance {
  if (!options) return model;

  const middleware: LanguageModelMiddleware[] = [];
  if (options.reasoning !== undefined) {
    middleware.push({
      specificationVersion: "v4",
      transformParams: async ({ params }) =>
        params.reasoning === undefined ? { ...params, reasoning: options.reasoning } : params,
    });
  }

  middleware.push(
    defaultSettingsMiddleware({
      settings: {
        maxOutputTokens: options.max_output_tokens,
        temperature: options.temperature,
        topP: options.top_p,
        topK: options.top_k,
        presencePenalty: options.presence_penalty,
        frequencyPenalty: options.frequency_penalty,
        stopSequences: options.stop_sequences,
        seed: options.seed,
        providerOptions: options.provider_options
          ? ({ [providerOptionsKey[type]]: options.provider_options } as ProviderOptions)
          : undefined,
      },
    }),
  );

  return wrapLanguageModel({ model, middleware });
}

/**
 * 根据模型别名获取模型实例
 * @param alias 在配置文件中配置的模型别名
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
    return applyModelOptions(provider(modelCfg.id), providerCfg.type, modelCfg.options);
  }
  throw new Error(`未找到别名为 "${alias}" 的模型，请检查配置文件`);
}

/** 根据模型职责获取当前时段应使用的模型实例。 */
export function getModelForRole(role: ModelRole): LanguageModel {
  return getModel(resolveModelAlias(config, role));
}

/**
 * 返回别名为 alias 的模型对应的 provider 配置与真实 model id，
 * 用于绕过 AI SDK 直接调用 provider API（如 mimo 的 video_url 扩展）。
 */
export function getModelConfig(alias: string) {
  for (const providerCfg of config.providers) {
    const modelCfg = providerCfg.models.find((m) => m.alias === alias);
    if (modelCfg) {
      return {
        type: providerCfg.type,
        baseUrl: providerCfg.options.base_url,
        apiKey: providerCfg.options.api_key,
        modelId: modelCfg.id,
      };
    }
  }
  throw new Error(`未找到别名为 "${alias}" 的模型，请检查配置文件`);
}

/** 根据模型职责获取当前时段应使用的 provider 配置与真实模型 ID。 */
export function getModelConfigForRole(role: ModelRole) {
  return getModelConfig(resolveModelAlias(config, role));
}
