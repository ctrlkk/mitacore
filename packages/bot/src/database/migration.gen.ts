import type { Migration } from "./migration";

export const migrations = (await Promise.all<{ default: Migration }>([import("./migration/0000_add_user_alias")])).map(
  (module) => module.default,
) satisfies Migration[];
