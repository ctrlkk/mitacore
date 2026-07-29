export type ProviderType = "anthropic" | "deepseek" | "openai" | "openai-compatible";

export type ProviderModel = {
  id: string;
  alias: string;
};

export type ProviderDraft = {
  id: string;
  type: ProviderType;
  base_url: string;
  api_key: string;
  models_status: "idle" | "loading" | "ready" | "stale" | "error";
  models: ProviderModel[];
};

export type ModelRoles = {
  plan: string;
  reply: string;
  main: string;
  multimodal_image: string;
  multimodal_video: string;
  multimodal_audio: string;
};

export type ModelConfigDraft = {
  providers: ProviderDraft[];
  roles: ModelRoles;
};

export function getModelAliases(draft: ModelConfigDraft): string[] {
  return Array.from(
    new Set(draft.providers.flatMap((provider) => provider.models.map((model) => model.alias.trim())).filter(Boolean)),
  );
}

export function removeModel(draft: ModelConfigDraft, providerId: string, modelIndex: number): ModelConfigDraft {
  const model = draft.providers.find((provider) => provider.id === providerId)?.models[modelIndex];
  if (!model) return draft;

  return {
    providers: draft.providers.map((provider) =>
      provider.id === providerId
        ? { ...provider, models: provider.models.filter((_, index) => index !== modelIndex) }
        : provider,
    ),
    roles: Object.fromEntries(
      Object.entries(draft.roles).map(([role, alias]) => [role, alias === model.alias ? "" : alias]),
    ) as ModelRoles,
  };
}

export function updateProviderConnection(
  draft: ModelConfigDraft,
  providerId: string,
  changes: Partial<Pick<ProviderDraft, "type" | "base_url" | "api_key">>,
): ModelConfigDraft {
  return {
    ...draft,
    providers: draft.providers.map((provider) =>
      provider.id === providerId ? { ...provider, ...changes, models_status: "stale" } : provider,
    ),
  };
}
