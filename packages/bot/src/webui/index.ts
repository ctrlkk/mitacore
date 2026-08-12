import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, posix, relative, resolve } from "node:path";
import { logger } from "@/logger";
import { dataPath, projectPath } from "@/utils/path";
import { config, ConfigValidationError, loadConfig, saveConfig } from "@/config";
import { delete_image_description, list_image_descriptions, set_media_description } from "@/database/media-cache";
import { IMAGE_CACHE_DIR, sanitizeImagePath, virtualToRealPath } from "@/utils/image-cache";
import {
  MAX_STICKER_SIZE,
  MAX_STICKERS,
  addSticker,
  getStickerPath,
  listStickers,
  removeSticker,
} from "@/message/stickers";
import { streamStickerSuggestion } from "@/agents/stickers";
import { z } from "zod";
import { channelController } from "@/app/channel-controller";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const PERSONA_PATH = projectPath("prompts", "role.txt");
const KNOWLEDGE_BASE_DIR = dataPath("workspace", "notepad");
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;

class WebUiValidationError extends Error {}

const textFileSchema = z.object({
  content: z.string().max(MAX_TEXT_FILE_SIZE, "文件内容不能超过 2 MB"),
});

const knowledgeFileSchema = textFileSchema.extend({
  path: z.string().trim().min(1, "请输入笔记路径").max(500, "笔记路径过长"),
  create_only: z.boolean().optional().default(false),
});

function getSafeKnowledgePath(rawPath: string) {
  const input = rawPath.replaceAll("\\", "/");
  if (input.includes("\0") || input.startsWith("/") || isAbsolute(input)) {
    throw new WebUiValidationError("笔记路径不正确");
  }

  const normalizedPath = posix.normalize(input);
  if (
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../") ||
    posix.extname(normalizedPath).toLocaleLowerCase() !== ".md"
  ) {
    throw new WebUiValidationError("笔记必须是知识库内的 Markdown 文件");
  }

  const fullPath = resolve(KNOWLEDGE_BASE_DIR, normalizedPath);
  const relativePath = relative(KNOWLEDGE_BASE_DIR, fullPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new WebUiValidationError("笔记路径不正确");
  }
  return { path: normalizedPath, fullPath };
}

function parseWikiLinks(content: string) {
  return [...content.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
    .map((match) => match[1]?.trim().replaceAll("\\", "/"))
    .filter((link): link is string => Boolean(link));
}

async function listKnowledgeNotes() {
  const paths: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === ".md") {
        paths.push(relative(KNOWLEDGE_BASE_DIR, fullPath).replaceAll("\\", "/"));
      }
    }
  }

  await visit(KNOWLEDGE_BASE_DIR);
  paths.sort((left, right) => left.localeCompare(right, "zh-CN"));
  const noteData = await Promise.all(
    paths.map(async (path) => {
      const fullPath = resolve(KNOWLEDGE_BASE_DIR, path);
      const [content, fileStat] = await Promise.all([readFile(fullPath, "utf8"), stat(fullPath)]);
      return {
        path,
        title: basename(path, extname(path)),
        folder: posix.dirname(path) === "." ? "" : posix.dirname(path),
        size: fileStat.size,
        updated_at: fileStat.mtimeMs,
        rawLinks: parseWikiLinks(content),
      };
    }),
  );

  const byPath = new Map(noteData.map((note) => [note.path.slice(0, -3).toLocaleLowerCase(), note.path]));
  const byTitle = new Map<string, string[]>();
  for (const note of noteData) {
    const key = note.title.toLocaleLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), note.path]);
  }

  return noteData.map(({ rawLinks, ...note }) => {
    const links = rawLinks.flatMap((rawLink) => {
      const link = rawLink.replace(/\.md$/i, "");
      const direct = byPath.get(link.toLocaleLowerCase());
      if (direct) return [direct];

      const relativeLink = posix.normalize(posix.join(note.folder, link));
      const relativeTarget = byPath.get(relativeLink.toLocaleLowerCase());
      if (relativeTarget) return [relativeTarget];

      const titleMatches = byTitle.get(posix.basename(link).toLocaleLowerCase());
      return titleMatches?.length === 1 ? titleMatches : [];
    });
    return { ...note, links: [...new Set(links)] };
  });
}

const imageUpdateSchema = z.object({
  description: z.string().trim().max(10_000, "图片描述不能超过 10000 个字符"),
});

const imageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().max(200).default(""),
  sort: z.enum(["newest", "oldest", "largest", "smallest"]).default("newest"),
});

const stickerNameSchema = z
  .string()
  .trim()
  .min(2, "贴纸名至少需要 2 个字符")
  .max(32, "贴纸名不能超过 32 个字符")
  .regex(/^[\p{L}][\p{L}\p{N}_-]+$/u, "贴纸名需以字母开头，且只能包含字母、数字、下划线或连字符");

const stickerDescriptionSchema = z
  .string()
  .trim()
  .min(1, "贴纸描述不能为空")
  .max(10_000, "贴纸描述不能超过 10000 个字符");

function getSafeImagePath(rawFilename: string) {
  const filename = basename(rawFilename);
  if (filename !== rawFilename || !IMAGE_EXTENSIONS.has(extname(filename).toLowerCase())) {
    throw new Error("图片文件名不正确");
  }
  const virtualPath = sanitizeImagePath(filename);
  return { filename, virtualPath, realPath: virtualToRealPath(virtualPath) };
}

const modelRequestSchema = z.object({
  type: z.enum(["anthropic", "openai-responses", "openai-compatible", "deepseek"]),
  base_url: z
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "仅支持 HTTP 或 HTTPS 地址"),
  api_key: z.string().trim().min(1, "请先填写 API Key"),
});

function getModelHeaders(type: z.infer<typeof modelRequestSchema>["type"], apiKey: string): Headers {
  if (type === "anthropic") {
    return new Headers({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  }
  return new Headers({ Authorization: `Bearer ${apiKey}` });
}

function getModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const response = payload as { data?: unknown; models?: unknown };
  const models = [response.data, response.models].flatMap((items) => {
    if (!Array.isArray(items)) return [];
    return items.flatMap((model) => {
      if (!model || typeof model !== "object") return [];
      const { id, name } = model as { id?: unknown; name?: unknown };
      if (typeof id === "string" && id) return [id];
      if (typeof name === "string" && name) return [name];
      return [];
    });
  });
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

const verifyCodeSchema = z.object({
  code: z.string().trim().min(1, "请输入验证码").max(32, "验证码格式不正确"),
});

function errorResponse(error: unknown) {
  if (error instanceof WebUiValidationError) {
    return { status: 400 as const, body: { error: { message: error.message } } };
  }
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

  app.get("/api/runtime", (c) => c.json(channelController.getSnapshot()));

  app.get("/api/runtime/events", (c) => {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (snapshot: ReturnType<typeof channelController.getSnapshot>) => {
          controller.enqueue(encoder.encode(`event: runtime\ndata: ${JSON.stringify(snapshot)}\n\n`));
        };
        send(channelController.getSnapshot());
        unsubscribe = channelController.subscribe(send);
      },
      cancel() {
        unsubscribe?.();
      },
    });
    c.req.raw.signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
    });
  });

  app.post("/api/weixin/login/verify-code", async (c) => {
    try {
      const { code } = verifyCodeSchema.parse(await c.req.json());
      if (!channelController.submitVerifyCode(code)) {
        return c.json({ error: { message: "当前没有等待输入验证码的登录请求" } }, 409);
      }
      return c.json({ accepted: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

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

  app.get("/api/persona", async (c) => {
    try {
      const content = await readFile(PERSONA_PATH, "utf8");
      return c.json({ path: "prompts/role.txt", content });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.put("/api/persona", async (c) => {
    try {
      const { content } = textFileSchema.parse(await c.req.json());
      await mkdir(dirname(PERSONA_PATH), { recursive: true });
      await writeFile(PERSONA_PATH, content, "utf8");
      return c.json({ saved: true, path: "prompts/role.txt" });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get("/api/knowledge", async (c) => {
    try {
      const notes = await listKnowledgeNotes();
      return c.json({
        notes,
        summary: { total: notes.length, links: notes.reduce((sum, note) => sum + note.links.length, 0) },
      });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get("/api/knowledge/note", async (c) => {
    try {
      const { path, fullPath } = getSafeKnowledgePath(z.string().parse(c.req.query("path")));
      const content = await readFile(fullPath, "utf8");
      return c.json({ path, content });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return c.json({ error: { message: "笔记不存在" } }, 404);
      }
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.put("/api/knowledge/note", async (c) => {
    try {
      const request = knowledgeFileSchema.parse(await c.req.json());
      const { path, fullPath } = getSafeKnowledgePath(request.path);
      const created = await stat(fullPath)
        .then(() => false)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        });
      if (!created && request.create_only) {
        return c.json({ error: { message: "同名笔记已存在，请换一个名称" } }, 409);
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, request.content, "utf8");
      return c.json({ saved: true, created, path }, created ? 201 : 200);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/api/restart", (c) => {
    setTimeout(() => process.exit(0), 100);
    return c.json({ restarting: true });
  });

  app.post("/api/models", async (c) => {
    try {
      const request = modelRequestSchema.parse(await c.req.json());
      const response = await fetch(`${request.base_url.replace(/\/+$/, "")}/models`, {
        headers: getModelHeaders(request.type, request.api_key),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`供应商返回 HTTP ${response.status}，请检查 API 地址和密钥`);

      return c.json({ models: getModelIds(await response.json()) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return c.json({ error: { message: "获取模型超时，请检查 API 地址和网络连接" } }, 504);
      }
      if (error instanceof TypeError && error.message === "fetch failed") {
        return c.json({ error: { message: "无法连接供应商，请检查 API 地址和网络连接" } }, 502);
      }
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get("/api/stickers", async (c) => {
    try {
      const stickers = await listStickers();
      return c.json({
        stickers: stickers.map((sticker) => ({
          ...sticker,
          url: `/api/stickers/${encodeURIComponent(sticker.name)}/content`,
        })),
        summary: { total: stickers.length, limit: MAX_STICKERS },
      });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/api/stickers/suggestion", async (c) => {
    try {
      const form = await c.req.formData();
      const image = form.get("image");
      const model = z
        .string()
        .trim()
        .optional()
        .parse(form.get("model") || undefined);
      if (!(image instanceof File) || image.size === 0) {
        return c.json({ error: { message: "请选择贴纸图片" } }, 400);
      }
      if (image.size > MAX_STICKER_SIZE) {
        return c.json({ error: { message: "贴纸图片不能超过 10 MB" } }, 400);
      }
      if (model && !config.providers.some((provider) => provider.models.some(({ alias }) => alias === model))) {
        return c.json({ error: { message: "所选模型不存在，请检查模型配置" } }, 400);
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of streamStickerSuggestion(image, model, c.req.raw.signal)) {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "生成贴纸建议失败";
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message })}\n`));
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "cache-control": "no-cache",
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get("/api/stickers/:name/content", async (c) => {
    try {
      const name = stickerNameSchema.parse(c.req.param("name"));
      const path = await getStickerPath(name);
      if (!path) return c.json({ error: { message: `贴纸 [${name}] 不存在` } }, 404);
      return new Response(Bun.file(path), { headers: { "cache-control": "private, max-age=300" } });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post("/api/stickers", async (c) => {
    try {
      const form = await c.req.formData();
      const name = stickerNameSchema.parse(form.get("name"));
      const description = stickerDescriptionSchema.parse(form.get("description"));
      const image = form.get("image");
      if (!(image instanceof File) || image.size === 0) {
        return c.json({ error: { message: "请选择贴纸图片" } }, 400);
      }
      await addSticker(name, description, image);
      return c.json({ created: true, name }, 201);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status === 500 ? 400 : response.status);
    }
  });

  app.delete("/api/stickers/:name", async (c) => {
    try {
      const name = stickerNameSchema.parse(c.req.param("name"));
      const path = await getStickerPath(name);
      if (!path) return c.json({ error: { message: `贴纸 [${name}] 不存在` } }, 404);
      await removeSticker(name);
      return c.json({ deleted: true });
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
      try {
        await access(realPath);
      } catch {
        return c.json({ error: { message: "图片不存在" } }, 404);
      }
      const file = await readFile(realPath);
      return new Response(file, { headers: { "cache-control": "private, max-age=300" } });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.patch("/api/images/:filename", async (c) => {
    try {
      const { virtualPath, realPath } = getSafeImagePath(c.req.param("filename"));
      try {
        await access(realPath);
      } catch {
        return c.json({ error: { message: "图片不存在" } }, 404);
      }
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
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();

    const index = await readFile(projectPath("webui", "index.html"));
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  return app;
}

export function startWebUi() {
  const app = createApp();
  const server = Bun.serve({
    fetch(request, server) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/runtime/events" || pathname === "/api/stickers/suggestion") {
        server.timeout(request, 0);
      }
      return app.fetch(request);
    },
    hostname: "127.0.0.1",
    port: Bun.env.WEBUI_PORT ?? 0,
  });
  logger.info({ url: `http://127.0.0.1:${server.port}` }, "WebUI 已启动");
}
