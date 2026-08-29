import { describe, expect, test } from "vitest";
import { defaultConfig } from "@/config";
import { resolveModelAlias } from "./model";

describe("resolveModelAlias", () => {
  test("按服务器本地时间匹配时段", () => {
    const now = new Date(2026, 0, 1, 23, 30);
    const modelConfig = {
      models: { ...defaultConfig.models, reply: "default" },
      model_schedule: {
        rules: [{ start: "23:00", end: "01:00", models: { reply: "overnight" } }],
      },
    };

    expect(resolveModelAlias(modelConfig, "reply", now)).toBe("overnight");
  });
});
