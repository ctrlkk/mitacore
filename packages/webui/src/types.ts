export type Scope = { mode: "whitelist" | "blacklist"; ids: string[] };

export type Provider = {
  name: string;
  type: "anthropic" | "deepseek" | "openai-responses" | "openai-compatible";
  options: { base_url: string; api_key: string };
  models: { id: string; alias: string }[];
};

export type Config = {
  napcat: {
    enabled: boolean;
    qq_id?: string;
    ws_url?: string;
    token?: string;
    groups: Scope;
    private_chats: Scope;
    group_members: Scope;
  };
  weixin: {
    enabled: boolean;
    account_id?: string;
    token?: string;
    users: Scope;
  };
  models: Record<"plan" | "reply" | "main" | "multimodal_image" | "multimodal_video" | "multimodal_audio", string>;
  providers: Provider[];
};

export type CachedImage = {
  filename: string;
  description: string;
  size: number;
  updated_at: number;
  url: string;
};

export const defaultConfig: Config = {
  napcat: {
    enabled: true,
    qq_id: "",
    ws_url: "",
    token: "",
    groups: { mode: "whitelist", ids: [] },
    private_chats: { mode: "whitelist", ids: [] },
    group_members: { mode: "blacklist", ids: [] },
  },
  weixin: {
    enabled: false,
    account_id: "",
    token: "",
    users: { mode: "blacklist", ids: [] },
  },
  models: { plan: "", reply: "", main: "", multimodal_image: "", multimodal_video: "", multimodal_audio: "" },
  providers: [],
};
