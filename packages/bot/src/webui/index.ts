import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "@/logger";
import { projectPath } from "@/utils/path";

function createApp() {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get("/api/config", async (c) => {
    return c.json({});
  });

  app.put("/api/config", async (c) => {
    return c.body(null, 204);
  });

  app.post("/api/models", async (c) => {
    return c.json({ models: [] });
  });

  app.use("*", serveStatic({ root: projectPath("webui") }));
  return app;
}

export function startWebUi() {
  const server = Bun.serve({
    fetch: createApp().fetch,
    hostname: "127.0.0.1",
    port: 3001,
  });
  logger.info({ url: `http://127.0.0.1:${server.port}` }, "WebUI 已启动");
  return { stop: () => server.stop() };
}
