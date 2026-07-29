import type { ModelConfigDraft, ProviderType } from "../api";

const modelsByProvider: Record<ProviderType, string[]> = {
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  openai: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-pro"],
  "openai-compatible": ["mimo-v2.5", "mimo-v2.5-thinking"],
};

export const initialDraft: ModelConfigDraft = {
  providers: [
    {
      id: "provider-deepseek",
      type: "deepseek",
      base_url: "https://api.deepseek.com",
      api_key: "",
      models_status: "ready",
      models: [
        { id: "deepseek-v4-flash", alias: "deepseek-v4-flash" },
        { id: "deepseek-v4-pro", alias: "deepseek-v4-pro" },
      ],
    },
    {
      id: "provider-mimo",
      type: "openai-compatible",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key: "",
      models_status: "ready",
      models: [{ id: "mimo-v2.5", alias: "mimo-v2.5" }],
    },
  ],
  roles: {
    plan: "deepseek-v4-flash",
    reply: "deepseek-v4-pro",
    main: "",
    multimodal_image: "mimo-v2.5",
    multimodal_video: "mimo-v2.5",
    multimodal_audio: "mimo-v2.5",
  },
};

export async function loadModels(type: ProviderType): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return modelsByProvider[type];
}
