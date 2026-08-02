import { and, eq } from "drizzle-orm";
import type { MediaKind } from "@/message/types";
import { db } from "./db";
import { mediaCache } from "./schema.sql";

export function get_media_description(path: string): string | undefined {
  return db.select({ description: mediaCache.description }).from(mediaCache).where(eq(mediaCache.path, path)).get()
    ?.description;
}

export function set_media_description(kind: MediaKind, path: string, description: string): void {
  const now = Date.now();
  db.insert(mediaCache)
    .values({ path, kind, description, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: mediaCache.path, set: { kind, description, updatedAt: now } })
    .run();
}

export function list_image_descriptions(): Map<string, string> {
  return new Map(
    db
      .select({ path: mediaCache.path, description: mediaCache.description })
      .from(mediaCache)
      .where(eq(mediaCache.kind, "image"))
      .all()
      .map((row) => [row.path, row.description]),
  );
}

export function delete_image_description(path: string): void {
  db.delete(mediaCache)
    .where(and(eq(mediaCache.kind, "image"), eq(mediaCache.path, path)))
    .run();
}
