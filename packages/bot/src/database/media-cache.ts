import { eq } from "drizzle-orm";
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

export type MediaDescription = { kind: MediaKind; description: string };

export function list_media_descriptions(): Map<string, MediaDescription> {
  return new Map(
    db
      .select({ path: mediaCache.path, kind: mediaCache.kind, description: mediaCache.description })
      .from(mediaCache)
      .all()
      .map((row) => [row.path, { kind: row.kind, description: row.description }]),
  );
}

export function delete_media_description(path: string): void {
  db.delete(mediaCache).where(eq(mediaCache.path, path)).run();
}
