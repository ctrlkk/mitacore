import type { Migration } from "./migration";

export const migrations = (
  await Promise.all<{ default: Migration }>([
    import("./migration/0000_parched_grim_reaper"),
    import("./migration/0001_image_cache"),
    import("./migration/0002_video_cache"),
    import("./migration/0003_media_cache"),
  ])
).map((module) => module.default) satisfies Migration[]
