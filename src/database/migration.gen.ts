import type { Migration } from "./migration";

export const migrations = (await Promise.all<{ default: Migration }>([])).map(
  (module) => module.default,
) satisfies Migration[];
