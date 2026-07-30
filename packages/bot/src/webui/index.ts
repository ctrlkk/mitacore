import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "@/logger";
import { projectPath } from "@/utils/path";
import { ConfigValidationError, loadConfig, saveConfig } from "@/config";
import { z } from "zod";

const modelRequestSchema = z.object({
  type: z.enum(["anthropic", "openai", "openai-compatible", "deepseek"]),
  base_url: z
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "仅支持 HTTP 或 HTTPS 地址"),
  api_key: z.string().trim().min(1, "请先填写 API Key"),
});

function errorResponse(error: unknown) {
  if (error instanceof ConfigValidationError) {
    return {
      status: 400 as const,
      body: {
        error: {
          message: error.message,
          fields: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400 as const,
      body: {
        error: {
          message: error.issues[0]?.message ?? "请求参数不正确",
          fields: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
        },
      },
    };
  }
  return {
    status: 500 as const,
    body: { error: { message: error instanceof Error ? error.message : "服务器内部错误" } },
  };
}

export function createApp() {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get("/api/config", (c) => {
    try {
      return c.json(loadConfig());
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.put("/api/config", async (c) => {
    try {
      await saveConfig(await c.req.json());
      return c.json({ saved: true, restart_required: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/api/models", async (c) => {
    try {
      const request = modelRequestSchema.parse(await c.req.json());
      const response = await fetch(`${request.base_url.replace(/\/$/, "")}/models`, {
        headers:
          request.type === "anthropic"
            ? { "x-api-key": request.api_key, "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${request.api_key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`供应商返回 HTTP ${response.status}，请检查 API 地址和密钥`);

      const payload = (await response.json()) as {
        data?: Array<{ id?: unknown }>;
        models?: Array<{ id?: unknown; name?: unknown }>;
      };
      const models = [
        ...(payload.data ?? []).map((model) => model.id),
        ...(payload.models ?? []).map((model) => model.id ?? model.name),
      ].filter((id): id is string => typeof id === "string" && Boolean(id));
      return c.json({ models: [...new Set(models)] });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.use("*", serveStatic({ root: projectPath("webui") }));
  return app;
}

export function startWebUi() {
  const server = Bun.serve({
    fetch: createApp().fetch,
    hostname: "127.0.0.1",
    port: 14251,
  });
  logger.info({ url: `http://127.0.0.1:${server.port}` }, "WebUI 已启动");
  return { stop: () => server.stop() };
}
