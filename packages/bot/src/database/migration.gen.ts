import type { Migration } from "./migration";

export const migrations = (
  await Promise.all<{ default: Migration }>([
    import("./migration/0000_parched_grim_reaper"),
    import("./migration/0001_image_cache"),
    import("./migration/0002_video_cache"),
    import("./migration/0003_media_cache"),
    import("./migration/0004_user_alias_last_seen"),
    import("./migration/0005_loving_celestials"),
    import("./migration/20260819040653_new_dragon_lord"),
  ])
).map((module) => module.default) satisfies Migration[];
