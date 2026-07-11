import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { dataPath } from "./utils/path";

/** 范围配置 Schema */
const scopeConfig = z.object({
  mode: z.enum(["whitelist", "blacklist"]).default("blacklist").describe("范围控制模式"),
  ids: z.array(z.string()).default([]).describe("范围控制的 ID 列表"),
});

const schema = z.object({
  napcat: z
    .object({
      ws_url: z.string().optional().describe("外部 NapCat WebSocket 地址"),
      token: z.string().optional().describe("外部 NapCat token"),
      qq_id: z.string().optional().describe("内置服务登录的 QQ ID"),
      groups: scopeConfig.default({ mode: "whitelist", ids: [] }).describe("群聊范围控制"),
      private_chats: scopeConfig.default({ mode: "whitelist", ids: [] }).describe("私聊范围控制"),
      group_members: scopeConfig.default({ mode: "blacklist", ids: [] }).describe("群内用户范围控制"),
    })
    .refine(
      (data) => {
        return (data.ws_url && data.token) || data.qq_id;
      },
      {
        message: "必须提供 (ws_url + token) 或 qq_id 其中一种配置",
      },
    )
    .describe("NapCat 配置"),
  providers: z
    .array(
      z.object({
        name: z.enum(["anthropic", "openai", "openai-compatible", "deepseek"]).describe("供应商类型"),
        options: z
          .object({
            base_url: z.url().describe("供应商 API 基础 URL"),
            api_key: z.string().describe("供应商 API 密钥"),
          })
          .describe("供应商选项"),
        models: z
          .array(
            z.object({
              id: z.string().describe("模型ID"),
              alias: z.string().describe("模型别名，用于防止模型id冲突"),
            }),
          )
          .describe("供应商提供的模型列表"),
      }),
    )
    .describe("供应商配置"),
  models: z
    .object({
      plan: z.string().describe("规划层使用的模型"),
      reply: z.string().describe("执行层使用的模型"),
      main: z.string().optional().describe("单 agent 模式的主模型，未配置时不可用"),
      multimodal_image: z.string().describe("用于图像理解的外挂模型"),
      multimodal_video: z.string().describe("用于视频理解的外挂模型"),
      multimodal_audio: z.string().describe("用于音频处理的外挂模型"),
    })
    .describe("各模块使用的模型配置"),
});

export type Config = z.infer<typeof schema>;

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
    "napcat.ws_url": "napcat 服务 URL",
    "napcat.token": "napcat 服务 token",
    "napcat.groups": "群聊范围控制",
    "napcat.private_chats": "私聊范围控制",
    "napcat.group_members": "群内用户范围控制",
    providers: "供应商配置",
    "models.plan": "规划层模型别名",
    "models.reply": "执行层模型别名",
    "models.main": "单 agent 模式主模型别名",
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

/** 加载并校验配置文件，必须在程序入口最先调用 */
function loadConfig(path = dataPath("config.toml")): Config {
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

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}

export const config = loadConfig();

if (import.meta.main) {
  console.log("配置加载成功:");
  console.log(JSON.stringify(config, null, 2));
}
