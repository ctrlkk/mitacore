import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readdir, stat, unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import { logger } from "@/logger";
import { projectPath } from "@/utils/path";
import { ConfigValidationError, loadConfig, saveConfig } from "@/config";
import { delete_image_description, list_image_descriptions, set_media_description } from "@/database/media-cache";
import { IMAGE_CACHE_DIR, sanitizeImagePath, virtualToRealPath } from "@/utils/image-cache";
import { z } from "zod";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

const imageUpdateSchema = z.object({
  description: z.string().trim().max(10_000, "图片描述不能超过 10000 个字符"),
});

const imageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().max(200).default(""),
  sort: z.enum(["newest", "oldest", "largest", "smallest"]).default("newest"),
});

function getSafeImagePath(rawFilename: string) {
  const filename = basename(rawFilename);
  if (filename !== rawFilename || !IMAGE_EXTENSIONS.has(extname(filename).toLowerCase())) {
    throw new Error("图片文件名不正确");
  }
  const virtualPath = sanitizeImagePath(filename);
  return { filename, virtualPath, realPath: virtualToRealPath(virtualPath) };
}

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

  app.get("/api/images", async (c) => {
    try {
      const query = imageListQuerySchema.parse(c.req.query());
      const descriptions = list_image_descriptions();
      const entries = await readdir(IMAGE_CACHE_DIR, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const imageEntries = (
        await Promise.all(
          entries
            .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
            .map(async (entry) => {
              const virtualPath = sanitizeImagePath(entry.name);
              const fileStat = await stat(virtualToRealPath(virtualPath)).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              });
              if (!fileStat) return undefined;
              return {
                filename: entry.name,
                path: virtualPath,
                description: descriptions.get(virtualPath) ?? "",
                size: fileStat.size,
                updated_at: fileStat.mtimeMs,
                url: `/api/images/${encodeURIComponent(entry.name)}/content`,
              };
            }),
        )
      ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      const totalSize = imageEntries.reduce((sum, image) => sum + image.size, 0);
      const keyword = query.search.toLocaleLowerCase();
      const filteredImages = imageEntries.filter((image) => {
        if (!keyword) return true;
        return `${image.filename}\n${image.description}`.toLocaleLowerCase().includes(keyword);
      });
      filteredImages.sort((left, right) => {
        if (query.sort === "oldest") return left.updated_at - right.updated_at;
        if (query.sort === "largest") return right.size - left.size;
        if (query.sort === "smallest") return left.size - right.size;
        return right.updated_at - left.updated_at;
      });

      const total = filteredImages.length;
      const totalPages = Math.max(1, Math.ceil(total / query.page_size));
      const page = Math.min(query.page, totalPages);
      const offset = (page - 1) * query.page_size;
      return c.json({
        images: filteredImages.slice(offset, offset + query.page_size),
        pagination: { page, page_size: query.page_size, total, total_pages: totalPages },
        summary: { total: imageEntries.length, total_size: totalSize },
      });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get("/api/images/:filename/content", async (c) => {
    try {
      const { realPath } = getSafeImagePath(c.req.param("filename"));
      const file = Bun.file(realPath);
      if (!(await file.exists())) return c.json({ error: { message: "图片不存在" } }, 404);
      return new Response(file, { headers: { "cache-control": "private, max-age=300" } });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.patch("/api/images/:filename", async (c) => {
    try {
      const { virtualPath, realPath } = getSafeImagePath(c.req.param("filename"));
      if (!(await Bun.file(realPath).exists())) return c.json({ error: { message: "图片不存在" } }, 404);
      const request = imageUpdateSchema.parse(await c.req.json());
      set_media_description("image", virtualPath, request.description);
      return c.json({ saved: true, description: request.description });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.delete("/api/images/:filename", async (c) => {
    try {
      const { virtualPath, realPath } = getSafeImagePath(c.req.param("filename"));
      await unlink(realPath);
      delete_image_description(virtualPath);
      return c.json({ deleted: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return c.json({ error: { message: "图片不存在" } }, 404);
      }
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
  server.unref();
  logger.info({ url: `http://127.0.0.1:${server.port}` }, "WebUI 已启动");
}
