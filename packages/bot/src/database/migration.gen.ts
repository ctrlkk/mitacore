import type { Migration } from "./migration";

export const migrations = (
  await Promise.all<{ default: Migration }>([
    import("./migration/0000_parched_grim_reaper"),
  ])
).map((module) => module.default) satisfies Migration[]
