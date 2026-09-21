import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig, validateConfig } from "@/config";
import { projectPath } from "@/utils/path";

const temporaryDirectories: string[] = [];

async function createConfigPaths() {
  const directory = await mkdtemp(join(tmpdir(), "mitacore-config-"));
  temporaryDirectories.push(directory);
  return {
    jsoncPath: join(directory, "config.jsonc"),
    jsonPath: join(directory, "config.json"),
    tomlPath: join(directory, "config.toml"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("配置校验", () => {
  it("默认只接收 OneBot 图片消息", () => {
    const config = validateConfig({});

    expect(config.napcat).toMatchObject({
      receive_image: true,
      receive_video: false,
      receive_audio: false,
    });
  });

  it("为各持久化会话提供独立的默认上下文策略", () => {
    const config = validateConfig({});

    expect(config.context).toEqual({
      plan: { max_tokens: 108000 },
      reply: { max_tokens: 108000 },
      main: { max_tokens: 108000 },
    });
  });

  it("接受各持久化会话的独立上下文策略", () => {
    const config = validateConfig({
      context: {
        plan: { max_tokens: 100000 },
        reply: { max_tokens: 90000 },
        main: { max_tokens: 80000 },
      },
    });

    expect(config.context).toEqual({
      plan: { max_tokens: 100000 },
      reply: { max_tokens: 90000 },
      main: { max_tokens: 80000 },
    });
  });

  it("后端允许低于前端限制的上下文窗口", () => {
    const config = validateConfig({
      context: {
        plan: { max_tokens: 31999 },
      },
    });

    expect(config.context.plan.max_tokens).toBe(31999);
  });

  it("允许单独关闭 OneBot 媒体消息", () => {
    const config = validateConfig({
      napcat: {
        receive_image: false,
        receive_video: false,
        receive_audio: false,
      },
    });

    expect(config.napcat).toMatchObject({
      receive_image: false,
      receive_video: false,
      receive_audio: false,
    });
  });

  it("接受 Google Gemini 原生供应商", () => {
    const config = validateConfig({
      providers: [
        {
          name: "Google Gemini",
          type: "google",
          options: {
            base_url: "https://generativelanguage.googleapis.com/v1beta",
            api_key: "test-key",
          },
          models: [{ id: "gemini-3.8-flash", alias: "gemini" }],
        },
      ],
    });

    expect(config.providers[0]).toMatchObject({
      name: "Google Gemini",
      type: "google",
      models: [{ id: "gemini-3.8-flash", alias: "gemini" }],
    });
  });

  it("接受模型默认选项", () => {
    const config = validateConfig({
      providers: [
        {
          name: "OpenAI",
          type: "openai-responses",
          options: {
            base_url: "https://api.openai.com/v1",
            api_key: "test-key",
          },
          models: [
            {
              id: "gpt-test",
              alias: "gpt-test",
              options: {
                max_output_tokens: 4096,
                temperature: 0.6,
                top_p: 0.9,
                top_k: 40,
                presence_penalty: 0.1,
                frequency_penalty: -0.1,
                seed: 42,
                reasoning: "high",
                provider_options: {
                  reasoningEffort: "high",
                  metadata: { source: "config", tags: ["test", 1, true] },
                },
              },
            },
          ],
        },
      ],
    });

    expect(config.providers[0]?.models[0]?.options).toEqual({
      max_output_tokens: 4096,
      temperature: 0.6,
      top_p: 0.9,
      top_k: 40,
      presence_penalty: 0.1,
      frequency_penalty: -0.1,
      seed: 42,
      reasoning: "high",
      provider_options: {
        reasoningEffort: "high",
        metadata: { source: "config", tags: ["test", 1, true] },
      },
    });
  });

  it("拒绝未声明的模型通用选项", () => {
    expect(() =>
      validateConfig({
        providers: [
          {
            name: "DeepSeek",
            type: "deepseek",
            options: {
              base_url: "https://api.deepseek.com",
              api_key: "test-key",
            },
            models: [{ id: "deepseek-chat", alias: "deepseek", options: { temprature: 0.5 } }],
          },
        ],
      }),
    ).toThrow("配置校验失败");
  });

  it("拒绝 provider_options 中无法写入 JSON 的值", () => {
    expect(() =>
      validateConfig({
        providers: [
          {
            name: "OpenAI",
            type: "openai-responses",
            options: { base_url: "https://api.openai.com/v1", api_key: "test-key" },
            models: [
              {
                id: "gpt-test",
                alias: "gpt-test",
                options: { provider_options: { generated_at: new Date() } },
              },
            ],
          },
        ],
      }),
    ).toThrow("配置校验失败");
  });
});

describe("配置文件", () => {
  it("解析带注释的 JSONC", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsoncPath, '{\n  // WebUI 配置\n  "max_queue": 22\n}\n');

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toMatchObject({ max_queue: 22 });
  });

  it("拒绝带尾随逗号的 JSONC", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsoncPath, '{\n  "max_queue": 22,\n}\n');

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("JSONC 配置文件解析失败");
  });

  it("仅存在 JSON 时加载 JSON 配置", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsonPath, '{"max_queue": 23}\n');

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toMatchObject({ max_queue: 23 });
  });

  it("仅存在 TOML 时迁移为 JSONC 并保留旧文件", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    const toml = "max_queue = 24\n";
    await writeFile(tomlPath, toml);

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toMatchObject({ max_queue: 24 });
    await expect(readFile(jsoncPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ $schema: "./config.schema.json", ...validateConfig({ max_queue: 24 }) }, null, 2)}\n`,
    );
    await expect(readFile(tomlPath, "utf8")).resolves.toBe(toml);
  });

  it("迁移成功后不再读取旧 TOML", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(tomlPath, "max_queue = 24\n");
    await loadConfig(jsoncPath, jsonPath, tomlPath);
    await writeFile(tomlPath, "max_queue = 99\n");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toMatchObject({ max_queue: 24 });
  });

  it("三种配置文件同时存在时按 JSONC、JSON、TOML 优先加载", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsoncPath, '{"max_queue": 25}\n');
    await writeFile(jsonPath, '{"max_queue": 26}\n');
    await writeFile(tomlPath, "max_queue = 27\n");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toMatchObject({ max_queue: 25 });
  });

  it("JSONC 损坏时不回退 JSON 或 TOML", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsoncPath, "{");
    await writeFile(jsonPath, '{"max_queue": 25}\n');
    await writeFile(tomlPath, "max_queue = 26\n");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("JSONC 配置文件解析失败");
  });

  it("JSONC 配置校验失败时不回退 JSON 或 TOML", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsoncPath, '{"max_queue":0}\n');
    await writeFile(jsonPath, '{"max_queue":25}\n');
    await writeFile(tomlPath, "max_queue = 26\n");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("配置校验失败");
  });

  it("JSON 损坏时不回退 TOML", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsonPath, "{");
    await writeFile(tomlPath, "max_queue = 27\n");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("JSON 配置文件解析失败");
  });

  it("JSON 配置校验失败时不回退 TOML", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsonPath, '{"max_queue":0}\n');
    await writeFile(tomlPath, "max_queue = 27\n");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("配置校验失败");
  });

  it("TOML 损坏时不生成 JSONC", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(tomlPath, "[broken");

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("旧 TOML 配置文件解析失败");
    await expect(access(jsoncPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("TOML 包含非 JSON 值时不生成 JSONC", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(
      tomlPath,
      [
        "[[providers]]",
        'name = "OpenAI"',
        'type = "openai-responses"',
        "[providers.options]",
        'base_url = "https://api.openai.com/v1"',
        'api_key = "test-key"',
        "[[providers.models]]",
        'id = "gpt-test"',
        'alias = "gpt-test"',
        "[providers.models.options.provider_options]",
        "generated_at = 1979-05-27T07:32:00Z",
        "",
      ].join("\n"),
    );

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).rejects.toThrow("配置校验失败");
    await expect(access(jsoncPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("三种配置文件都不存在时使用默认配置，默认保存写入 JSONC", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toEqual(defaultConfig);
    await expect(access(jsoncPath)).rejects.toMatchObject({ code: "ENOENT" });
    await saveConfig({ max_queue: 28 });
    await expect(readFile(jsoncPath, "utf8")).resolves.toContain('"max_queue": 28');
  });

  it("仅加载 JSON 后默认保存仍写入 JSON", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    const customPath = `${jsonPath}.custom`;
    await writeFile(jsonPath, '{"max_queue": 29}\n');

    await loadConfig(jsoncPath, jsonPath, tomlPath);
    await saveConfig({ max_queue: 30 });
    await saveConfig({ max_queue: 31 }, customPath);
    await saveConfig({ max_queue: 32 });

    await expect(readFile(jsonPath, "utf8")).resolves.toContain('"max_queue": 32');
    await expect(readFile(customPath, "utf8")).resolves.toContain('"max_queue": 31');
    await expect(access(jsoncPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saveConfig 写入格式化 JSON", async () => {
    const { jsonPath } = await createConfigPaths();
    const saved = await saveConfig({ max_queue: 28 }, jsonPath);

    await expect(readFile(jsonPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ $schema: "./config.schema.json", ...saved }, null, 2)}\n`,
    );
  });

  it("保存 JSONC 时移除注释并保持内容有效", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    await writeFile(jsoncPath, '{\n  // 旧注释\n  "max_queue": 31\n}\n');
    await loadConfig(jsoncPath, jsonPath, tomlPath);

    const saved = await saveConfig({ max_queue: 32 });
    const content = await readFile(jsoncPath, "utf8");

    expect(content).toBe(`${JSON.stringify({ $schema: "./config.schema.json", ...saved }, null, 2)}\n`);
    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toEqual(saved);
    expect(saved).not.toHaveProperty("$schema");
  });

  it("provider_options 嵌套值可往返保存和加载", async () => {
    const { jsoncPath, jsonPath, tomlPath } = await createConfigPaths();
    const input = {
      providers: [
        {
          name: "OpenAI",
          type: "openai-responses" as const,
          options: { base_url: "https://api.openai.com/v1", api_key: "test-key" },
          models: [
            {
              id: "gpt-test",
              alias: "gpt-test",
              options: { provider_options: { metadata: { tags: ["test", 1, true] } } },
            },
          ],
        },
      ],
    };

    const saved = await saveConfig(input, jsonPath);

    await expect(loadConfig(jsoncPath, jsonPath, tomlPath)).resolves.toEqual(saved);
  });

  it("生成可独立使用的输入 Schema，保留说明、复杂示例与约束", async () => {
    const { jsonPath } = await createConfigPaths();
    const generate = () =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", projectPath("packages/bot/scripts/generate-config-schema.ts"), jsonPath],
        { cwd: projectPath("packages/bot") },
      );
    await generate();
    const content = await readFile(jsonPath, "utf8");
    const schema = JSON.parse(content);

    expect(schema.required ?? []).toEqual([]);
    expect(schema.properties.$schema.type).toBe("string");
    expect(schema.properties.max_queue).toMatchObject({ type: "integer", minimum: 1, default: 10 });
    expect(schema.properties.max_queue.description).toBeTruthy();
    expect(schema.properties.napcat.properties.enabled.default).toBe(false);
    expect(schema.properties.providers.items.properties.type.enum).toContain("deepseek");
    expect(schema.properties.model_schedule.properties.rules.maxItems).toBe(50);
    expect(schema.properties.context.properties.plan.properties.max_tokens).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      default: 108000,
    });
    expect(schema.properties.context.properties.plan.properties).not.toHaveProperty("preserve_tokens");
    expect(schema.properties.model_schedule.properties.rules.examples).toEqual([
      [{ start: "00:00", end: "08:00", models: { reply: "deepseek-v4-flash" } }],
    ]);
    expect(content.match(/"examples":/g)).toHaveLength(1);

    await generate();
    await expect(readFile(jsonPath, "utf8")).resolves.toBe(content);
  });
});
