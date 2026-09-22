import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse } from "smol-toml";
import { z } from "zod";
import { projectPath } from "./utils/path";

const providerType = z.enum(["anthropic", "google", "openai-responses", "openai-compatible", "deepseek"]);

const modelRoles = [
  "plan",
  "reply",
  "main",
  "task_explore",
  "task_general",
  "multimodal_image",
  "multimodal_video",
  "multimodal_audio",
] as const;

export type ModelRole = (typeof modelRoles)[number];

const defaultScopeConfig = { mode: "whitelist" as const, ids: [] as string[] };
const defaultNapcatConfig = {
  enabled: false,
  qq_id: "",
  wake_keywords: ["aliya", "阿丽亚", "阿丽娅", "Aliya"],
  groups: defaultScopeConfig,
  private_chats: defaultScopeConfig,
  group_members: { mode: "blacklist" as const, ids: [] as string[] },
  admins: [] as string[],
  receive_image: true,
  receive_video: false,
  receive_audio: false,
};
const defaultWeixinConfig = { enabled: false, account_id: "", token: "" };
const defaultQQBotConfig = { enabled: false, app_id: "", app_secret: "", admins: [] as string[] };
const defaultModelConfig = {
  plan: "deepseek-v4-flash",
  reply: "deepseek-v4-pro",
  main: "deepseek-v4-flash",
  task_explore: "deepseek-v4-flash",
  task_general: "deepseek-v4-pro",
  multimodal_image: "mimo-v2.5",
  multimodal_video: "mimo-v2.5",
  multimodal_audio: "mimo-v2.5",
};
const defaultModelSchedule = { rules: [] };
const defaultContextConfig = {
  plan: { max_tokens: 108000 },
  reply: { max_tokens: 108000 },
  main: { max_tokens: 108000 },
};
const defaultProviders = [
  {
    name: "deepseek官网",
    type: "deepseek" as const,
    options: { base_url: "https://api.deepseek.com", api_key: "sk-xxxx" },
    models: [
      { id: "deepseek-v4-flash", alias: "deepseek-v4-flash" },
      { id: "deepseek-v4-pro", alias: "deepseek-v4-pro" },
    ],
  },
  {
    name: "小米Mimo",
    type: "openai-compatible" as const,
    options: { base_url: "https://api.xiaomimimo.com/v1", api_key: "sk-xxxx" },
    models: [{ id: "mimo-v2.5", alias: "mimo-v2.5" }],
  },
];

const scopeSchema = z.object({
  mode: z
    .enum(["whitelist", "blacklist"])
    .default("blacklist")
    .describe("范围控制模式：whitelist 仅允许列表内对象，blacklist 排除列表内对象"),
  ids: z.array(z.string()).default([]).describe("范围控制的 ID 列表，使用字符串格式"),
});

const napcatSchema = z.object({
  enabled: z.boolean().default(false).describe("是否启用 NapCat 渠道"),
  ws_url: z.string().optional().describe("外部 NapCat WebSocket 地址；省略时使用内置服务，不清楚用途时建议保持省略"),
  token: z.string().optional().describe("外部 NapCat 服务令牌，与 ws_url 配套使用"),
  qq_id: z.string().optional().describe("内置 NapCat 启动器登录的机器人 QQ 号，不是日常使用的个人 QQ 号"),
  wake_keywords: z
    .array(z.string().trim().min(1, "唤醒关键词不能为空"))
    .default([])
    .describe("群聊消息包含任一关键词时可无需 @ 机器人触发回复；空数组表示只通过 @ 唤醒"),
  groups: scopeSchema.default(defaultScopeConfig).describe("群聊范围控制；可用群号白名单或黑名单"),
  private_chats: scopeSchema.default(defaultScopeConfig).describe("私聊范围控制；通常将自己使用的 QQ 号加入白名单"),
  group_members: scopeSchema
    .default({ mode: "blacklist", ids: [] })
    .describe("在已允许的群内，进一步控制可触发机器人的成员"),
  admins: z.array(z.string()).default([]).describe("管理员 QQ 号列表；只有管理员可使用 /help、/ping 和 /undo 指令"),
  receive_image: z.boolean().default(true).describe("是否接收图片消息"),
  receive_video: z.boolean().default(false).describe("是否接收视频消息"),
  receive_audio: z.boolean().default(false).describe("是否接收音频消息"),
});

const weixinSchema = z.object({
  enabled: z.boolean().default(false).describe("是否启用微信渠道"),
  account_id: z
    .string()
    .trim()
    .optional()
    .describe("微信 Bot 账号 ID；启用且未填写凭据时会引导登录，登录成功后自动写回配置"),
  token: z.string().trim().optional().describe("微信 Bot token；启用且未填写凭据时会引导登录，登录成功后自动写回配置"),
});

const qqbotSchema = z.object({
  enabled: z.boolean().default(false).describe("是否启用 QQ Bot 渠道"),
  app_id: z
    .string()
    .trim()
    .optional()
    .describe("QQ Bot AppID；启用且未填写凭据时会输出扫码链接，登录成功后自动写回配置"),
  app_secret: z
    .string()
    .trim()
    .optional()
    .describe("QQ Bot AppSecret；启用且未填写凭据时会输出扫码链接，登录成功后自动写回配置"),
  admins: z.array(z.string()).default([]).describe("管理员用户 openid 列表"),
});

const modelSchema = z.object({
  plan: z.string().trim().default("").describe("规划层使用的模型别名，应在 providers.models 中定义"),
  reply: z.string().trim().default("").describe("回复层使用的模型别名，应在 providers.models 中定义"),
  main: z
    .string()
    .trim()
    .default("")
    .describe("单 agent 模式的主模型别名；启用后取代 plan 与 reply，同时承担规划和回复"),
  task_explore: z.string().trim().default("").describe("task 工具中只读 explore 子代理使用的模型别名"),
  task_general: z.string().trim().default("").describe("task 工具中可读写 general 子代理使用的模型别名"),
  multimodal_image: z.string().trim().default("").describe("用于图像理解的模型别名"),
  multimodal_video: z.string().trim().default("").describe("用于视频理解的模型别名"),
  multimodal_audio: z.string().trim().default("").describe("用于音频理解的模型别名"),
});

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须为 HH:mm 格式");

const modelScheduleRuleSchema = z
  .object({
    start: timeOfDay.describe("按服务器本地时间生效的开始时间，使用 HH:mm 格式"),
    end: timeOfDay.describe("按服务器本地时间生效的结束时间，使用 HH:mm 格式"),
    models: modelSchema.partial().describe("在此时段临时覆盖的模型职责"),
  })
  .superRefine((rule, ctx) => {
    if (rule.start === rule.end) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "开始与结束时间不能相同" });
    }
    if (Object.keys(rule.models).length === 0) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "至少需要覆盖一个模型职责" });
    }
  });

const modelScheduleSchema = z.object({
  rules: z
    .array(modelScheduleRuleSchema)
    .max(50, "最多配置 50 条时段规则")
    .default([])
    .describe("按服务器本地时间临时覆盖模型职责的时段规则，最多 50 条")
    .meta({ examples: [[{ start: "00:00", end: "08:00", models: { reply: "deepseek-v4-flash" } }]] }),
});

const contextPolicySchema = z.object({
  max_tokens: z.number().int().positive().default(108000).describe("触发上下文压缩的 token 数"),
});

const contextSchema = z.object({
  plan: contextPolicySchema.default(defaultContextConfig.plan).describe("规划层历史的上下文管理策略"),
  reply: contextPolicySchema.default(defaultContextConfig.reply).describe("回复层历史的上下文管理策略"),
  main: contextPolicySchema.default(defaultContextConfig.main).describe("单 agent 模式历史的上下文管理策略"),
});

const modelOptionsSchema = z
  .object({
    max_output_tokens: z.number().int().positive().optional().describe("默认最大输出 token 数"),
    temperature: z.number().optional().describe("默认采样温度，具体范围由模型供应商决定"),
    top_p: z.number().min(0).max(1).optional().describe("默认 nucleus sampling 参数"),
    top_k: z.number().int().positive().optional().describe("默认 top-k sampling 参数"),
    presence_penalty: z.number().optional().describe("默认 presence penalty"),
    frequency_penalty: z.number().optional().describe("默认 frequency penalty"),
    seed: z.number().int().optional().describe("默认随机种子"),
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .optional()
      .describe("默认推理强度"),
    provider_options: z
      .record(z.string(), z.json())
      .optional()
      .describe("传递给当前模型供应商的专属 JSON 选项，字段名保持供应商原始格式"),
  })
  .strict();

const providerSchema = z.object({
  name: z.string().trim().min(1, "供应商名称不能为空").describe("供应商名称"),
  type: providerType.describe(
    "供应商端点类型，决定底层 API 协议：anthropic 为 Messages API，google 为 Gemini 原生 API，deepseek 为支持 reasoning_content 的 OpenAI 兼容接口，openai-compatible 为 Chat Completions 兼容接口，openai-responses 为 Responses API",
  ),
  options: z
    .object({
      base_url: z
        .url()
        .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "仅支持 HTTP 或 HTTPS 地址")
        .describe("供应商 API 基础 URL"),
      api_key: z.string().trim().min(1, "API 密钥不能为空").describe("供应商 API 密钥"),
    })
    .describe("供应商选项"),
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1, "模型 ID 不能为空").describe("供应商 API 使用的真实模型 ID"),
        alias: z
          .string()
          .trim()
          .min(1, "模型别名不能为空")
          .describe("其他配置引用的稳定模型别名，也可避免多供应商模型重名"),
        options: modelOptionsSchema.optional().describe("模型调用的默认参数；调用方显式传入的同名参数优先"),
      }),
    )
    .min(1, "至少需要配置一个模型")
    .describe("供应商提供的模型列表"),
});

export const configSchema = z
  .object({
    napcat: napcatSchema.default(defaultNapcatConfig),
    weixin: weixinSchema.default(defaultWeixinConfig),
    qqbot: qqbotSchema.default(defaultQQBotConfig),
    max_queue: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe("单个会话单次处理前最多暂存并合并的消息数，不是模型上下文长度；超出时会丢弃最早的消息"),
    debounce_ms: z
      .number()
      .int()
      .min(1000)
      .max(10000)
      .default(1000)
      .describe("收到最后一条消息后等待多久再判断是否处理（毫秒），用于合并连续消息"),
    preprocess_group_media: z
      .boolean()
      .default(true)
      .describe("是否在群聊媒体消息入队时立即下载并转述；关闭后仅在消息触发回复时处理，私聊不受影响"),
    providers: z
      .array(providerSchema)
      .default(defaultProviders)
      .describe("供应商配置，可配置多个供应商，每个供应商至少包含一个模型"),
    models: modelSchema.default(defaultModelConfig).describe("各模块使用的模型配置"),
    model_schedule: modelScheduleSchema.default(defaultModelSchedule).describe("按时段切换模型的配置"),
    context: contextSchema.default(defaultContextConfig).describe("各持久化会话的上下文管理策略"),
  })
  .superRefine((config, ctx) => {
    const hasEnabledChannel = config.napcat.enabled || config.weixin.enabled || config.qqbot.enabled;
    if (!hasEnabledChannel) return;

    if (config.providers.length === 0) {
      ctx.addIssue({ code: "custom", path: ["providers"], message: "启用渠道前至少需要配置一个供应商" });
      return;
    }

    const aliases = new Set(config.providers.flatMap((provider) => provider.models.map((model) => model.alias)));
    for (const role of modelRoles) {
      const alias = config.models[role];
      if (aliases.has(alias)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["models", role],
        message: alias ? `模型别名 "${alias}" 不存在` : "启用渠道前必须配置模型别名",
      });
    }

    for (const [ruleIndex, rule] of config.model_schedule.rules.entries()) {
      for (const [role, alias] of Object.entries(rule.models)) {
        if (aliases.has(alias)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["model_schedule", "rules", ruleIndex, "models", role],
          message: alias ? `模型别名 "${alias}" 不存在` : "模型别名不能为空",
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
export const defaultConfig: Config = configSchema.parse({});
export let config = structuredClone(defaultConfig);
let activeConfigPath = projectPath("config.jsonc");

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function validateConfig(input: unknown): Config {
  const result = configSchema.safeParse(input);
  if (!result.success) throw new ConfigValidationError("配置校验失败", result.error.issues);
  return result.data;
}

async function writeConfigFile(validated: Config, path: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ $schema: "./config.schema.json", ...validated }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readOptionalConfigFile(path: string, type: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 ${type} 配置文件 ${path}：${message}`);
  }
}

function parseJsoncConfig(raw: string, path: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length > 0) throw new Error(`JSONC 配置文件解析失败：${path}`);
  return parsed;
}

/** 异步加载并校验配置文件；文件不存在时使用安全的默认配置启动 WebUI。 */
export async function loadConfig(
  jsoncPath = projectPath("config.jsonc"),
  jsonPath = projectPath("config.json"),
  legacyTomlPath = projectPath("config.toml"),
): Promise<Config> {
  const jsonc = await readOptionalConfigFile(jsoncPath, "JSONC");
  if (jsonc !== undefined) {
    const validated = validateConfig(parseJsoncConfig(jsonc, jsoncPath));
    activeConfigPath = jsoncPath;
    config = validated;
    return config;
  }

  const json = await readOptionalConfigFile(jsonPath, "JSON");
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`JSON 配置文件解析失败：${jsonPath}`);
    }
    const validated = validateConfig(parsed);
    activeConfigPath = jsonPath;
    config = validated;
    return config;
  }

  const toml = await readOptionalConfigFile(legacyTomlPath, "旧 TOML");
  if (toml !== undefined) {
    let parsed: unknown;
    try {
      parsed = parse(toml);
    } catch {
      throw new Error(`旧 TOML 配置文件解析失败：${legacyTomlPath}`);
    }

    const validated = validateConfig(parsed);
    try {
      await writeConfigFile(validated, jsoncPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`迁移配置写入失败 ${jsoncPath}：${message}`);
    }
    activeConfigPath = jsoncPath;
    config = validated;
    return config;
  }

  activeConfigPath = jsoncPath;
  config = structuredClone(defaultConfig);
  return config;
}

export async function saveConfig(input: unknown, path = activeConfigPath): Promise<Config> {
  const validated = validateConfig(input);
  await writeConfigFile(validated, path);
  config = validated;
  return config;
}
