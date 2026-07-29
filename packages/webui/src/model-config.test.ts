import { describe, expect, test } from "bun:test";
import { getModelAliases, removeModel, updateProviderConnection, type ModelConfigDraft } from "./model-config";

const draft: ModelConfigDraft = {
  providers: [
    {
      id: "provider-deepseek",
      type: "deepseek",
      base_url: "https://api.deepseek.com",
      api_key: "",
      models_status: "ready",
      models: [
        { id: "deepseek-v4-flash", alias: "fast" },
        { id: "deepseek-v4-pro", alias: "pro" },
      ],
    },
  ],
  roles: {
    plan: "fast",
    reply: "pro",
    main: "",
    multimodal_image: "",
    multimodal_video: "",
    multimodal_audio: "",
  },
};

describe("模型配置草稿", () => {
  test("汇总所有供应商的非空别名并去重", () => {
    expect(
      getModelAliases({ ...draft, providers: [...draft.providers, { ...draft.providers[0]!, id: "provider-copy" }] }),
    ).toEqual(["fast", "pro"]);
  });

  test("删除被角色引用的模型会清空对应角色", () => {
    expect(removeModel(draft, "provider-deepseek", 1).roles).toMatchObject({ plan: "fast", reply: "" });
  });

  test("修改供应商连接会保留模型配置并标记为待刷新", () => {
    const updated = updateProviderConnection(draft, "provider-deepseek", { base_url: "https://example.com/v1" });
    expect(updated.providers[0]).toMatchObject({ base_url: "https://example.com/v1", models_status: "stale" });
    expect(updated.providers[0]?.models).toHaveLength(2);
  });
});
