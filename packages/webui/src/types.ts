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
    wake_keywords: string[];
    groups: Scope;
    private_chats: Scope;
    group_members: Scope;
    admins: string[];
  };
  weixin: {
    enabled: boolean;
    account_id?: string;
    token?: string;
  };
  qqbot: {
    enabled: boolean;
    app_id?: string;
    app_secret?: string;
    admins: string[];
  };
  max_queue: number;
  debounce_ms: number;
  models: Record<
    | "plan"
    | "reply"
    | "main"
    | "task_explore"
    | "task_general"
    | "multimodal_image"
    | "multimodal_video"
    | "multimodal_audio",
    string
  >;
  model_schedule: {
    timezone: string;
    rules: {
      start: string;
      end: string;
      models: Partial<Config["models"]>;
    }[];
  };
  providers: Provider[];
};

export type CachedImage = {
  filename: string;
  description: string;
  size: number;
  updated_at: number;
  url: string;
};

export type Sticker = {
  name: string;
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
    wake_keywords: [],
    groups: { mode: "whitelist", ids: [] },
    private_chats: { mode: "whitelist", ids: [] },
    group_members: { mode: "blacklist", ids: [] },
    admins: [],
  },
  weixin: {
    enabled: false,
    account_id: "",
    token: "",
  },
  qqbot: {
    enabled: false,
    app_id: "",
    app_secret: "",
    admins: [],
  },
  max_queue: 10,
  debounce_ms: 1000,
  models: {
    plan: "",
    reply: "",
    main: "",
    task_explore: "",
    task_general: "",
    multimodal_image: "",
    multimodal_video: "",
    multimodal_audio: "",
  },
  model_schedule: {
    timezone: "Asia/Shanghai",
    rules: [],
  },
  providers: [],
};
