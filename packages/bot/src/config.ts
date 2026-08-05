import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";
import { z } from "zod";
import { projectPath } from "./utils/path";
import { logger } from "@/logger";

/** 范围配置 Schema */
const scopeConfig = z.object({
  mode: z.enum(["whitelist", "blacklist"]).default("blacklist").describe("范围控制模式"),
  ids: z.array(z.string()).default([]).describe("范围控制的 ID 列表"),
});

const providerType = z.enum(["anthropic", "openai-responses", "openai-compatible", "deepseek"]);

const providerConfig = z.object({
  name: z.string().trim().min(1, "供应商名称不能为空").describe("供应商名称"),
  type: providerType.describe("供应商端点类型"),
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
        id: z.string().trim().min(1, "模型 ID 不能为空").describe("模型ID"),
        alias: z.string().trim().min(1, "模型别名不能为空").describe("模型别名，用于防止模型id冲突"),
      }),
    )
    .min(1, "至少需要配置一个模型")
    .describe("供应商提供的模型列表"),
});

const schema = z
  .object({
    napcat: z
      .object({
        enabled: z.boolean().default(true).describe("是否启用 NapCat 渠道"),
        ws_url: z.string().optional().describe("外部 NapCat WebSocket 地址"),
        token: z.string().optional().describe("外部 NapCat token"),
        qq_id: z.string().optional().describe("内置服务登录的 QQ ID"),
        groups: scopeConfig.default({ mode: "whitelist", ids: [] }).describe("群聊范围控制"),
        private_chats: scopeConfig.default({ mode: "whitelist", ids: [] }).describe("私聊范围控制"),
        group_members: scopeConfig.default({ mode: "blacklist", ids: [] }).describe("群内用户范围控制"),
      })
      .refine(
        (data) => {
          return !data.enabled || Boolean((data.ws_url && data.token) || data.qq_id);
        },
        {
          message: "必须提供 (ws_url + token) 或 qq_id 其中一种配置",
        },
      )
      .describe("NapCat 配置"),
    weixin: z
      .object({
        enabled: z.boolean().default(false).describe("是否启用微信渠道"),
        account_id: z.string().trim().optional().describe("扫码后获得的微信 Bot 账号 ID"),
        token: z.string().trim().optional().describe("扫码后获得的微信 Bot token"),
      })
      .default({
        enabled: false,
      })
      .describe("微信渠道配置"),
    economy_mode: z.boolean().default(false).describe("是否启用节约模式"),
    providers: z.array(providerConfig).min(1, "至少需要配置一个供应商").describe("供应商配置"),
    models: z
      .object({
        plan: z.string().describe("规划层使用的模型"),
        reply: z.string().describe("执行层使用的模型"),
        main: z.string().describe("单 agent 模式的主模型，未配置时不可用"),
        task_explore: z.string().describe("task explore 子代理使用的模型"),
        task_general: z.string().describe("task general 子代理使用的模型"),
        multimodal_image: z.string().describe("用于图像理解的外挂模型"),
        multimodal_video: z.string().describe("用于视频理解的外挂模型"),
        multimodal_audio: z.string().describe("用于音频处理的外挂模型"),
      })
      .describe("各模块使用的模型配置"),
  })
  .superRefine((data, ctx) => {
    if (!data.napcat.enabled && !data.weixin.enabled) {
      ctx.addIssue({ code: "custom", path: ["napcat", "enabled"], message: "NapCat 与微信至少启用一个渠道" });
    }

    if (data.weixin.enabled && Boolean(data.weixin.account_id) !== Boolean(data.weixin.token)) {
      ctx.addIssue({
        code: "custom",
        path: ["weixin"],
        message: "account_id 与 token 必须同时配置；都不配置时会启动扫码登录",
      });
    }
    const aliases = data.providers.flatMap((provider) => provider.models.map((model) => model.alias));
    aliases.forEach((alias, index) => {
      if (aliases.indexOf(alias) !== index) {
        ctx.addIssue({ code: "custom", path: ["providers"], message: `模型别名不能重复：${alias}` });
      }
    });

    Object.entries(data.models).forEach(([role, alias]) => {
      if (alias && !aliases.includes(alias)) {
        ctx.addIssue({ code: "custom", path: ["models", role], message: `未找到别名为 ${alias} 的模型` });
      }
    });
  });

export type Config = z.infer<typeof schema>;

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function formatZodError(error: z.ZodError): string {
  const lines: string[] = ["配置校验失败，请检查以下字段："];
  for (const issue of error.issues) {
    const location = formatPath(issue.path);
    // 标注该字段在 config.toml 中的含义
    const desc = getFieldDescription(issue.path);
    const descSuffix = desc ? ` (${desc})` : "";
    lines.push(`  • ${location}${descSuffix}`);
    lines.push(`      原因：${issue.message}`);
  }
  return lines.join("\n");
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(根)";
  return path
    .map((p, i) => {
      if (typeof p === "number") return `[${p}]`;
      if (i === 0) return String(p);
      return `.${String(p)}`;
    })
    .join("");
}

function getFieldDescription(path: PropertyKey[]): string | undefined {
  const descMap: Record<string, string> = {
    "napcat.enabled": "是否启用 NapCat 渠道",
    "napcat.ws_url": "napcat 服务 URL",
    "napcat.token": "napcat 服务 token",
    "napcat.groups": "群聊范围控制",
    "napcat.private_chats": "私聊范围控制",
    "napcat.group_members": "群内用户范围控制",
    "weixin.enabled": "是否启用微信渠道",
    "weixin.account_id": "微信 Bot 账号 ID",
    "weixin.token": "微信 Bot token",
    economy_mode: "是否启用节约模式",
    providers: "供应商配置",
    "providers.type": "供应商端点类型",
    "models.plan": "规划层模型别名",
    "models.reply": "执行层模型别名",
    "models.main": "单 agent 模式主模型别名",
    "models.task_explore": "task explore 子代理模型别名",
    "models.task_general": "task general 子代理模型别名",
    "models.multimodal_image": "图像理解模型别名",
    "models.multimodal_video": "视频理解模型别名",
    "models.multimodal_audio": "音频处理模型别名",
  };
  // 过滤掉 symbol，并将路径转为字符串键
  const key = path
    .filter((p) => typeof p === "string" || typeof p === "number")
    .map(String)
    .join(".");

  if (descMap[key]) return descMap[key];
  for (const k of Object.keys(descMap)) {
    if (key.startsWith(k + ".") || key.startsWith(k)) return descMap[k];
  }
  return undefined;
}

export function validateConfig(input: unknown): Config {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConfigValidationError(formatZodError(result.error), result.error.issues);
  return result.data;
}

/** 加载并校验配置文件，必须在程序入口最先调用 */
export function loadConfig(path = projectPath("config.toml")): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`无法读取配置文件 ${path}：${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`配置文件 TOML 解析失败：${msg}`);
  }

  return validateConfig(parsed);
}

export async function saveConfig(input: unknown, path = projectPath("config.toml")): Promise<Config> {
  const validated = validateConfig(input);
  const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${stringify(validated as unknown as TomlTableWithoutBigInt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    return validated;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export const config = loadConfig();

if (import.meta.main) {
  logger.info({ config }, "配置加载成功");
}
