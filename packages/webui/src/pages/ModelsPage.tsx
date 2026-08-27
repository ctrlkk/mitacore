import { LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, Input, Select } from "antd";
import { ModelPicker } from "@/components/ModelPicker";
import type { Config, Provider } from "@/types";

type Props = {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  updateProvider: (index: number, patch: Partial<Provider>) => void;
};

const roles = [
  ["plan", "规划"],
  ["reply", "回复"],
  ["main", "主 Agent"],
  ["task_explore", "Task 检索子 Agent"],
  ["task_general", "Task 通用子 Agent"],
  ["multimodal_image", "图像理解"],
  ["multimodal_video", "视频理解"],
  ["multimodal_audio", "音频理解"],
] as const;

export function ModelsPage({ config, setConfig, updateProvider }: Props) {
  const [loading, setLoading] = useState<Record<number, boolean>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [options, setOptions] = useState<Record<number, string[]>>({});
  const aliases = useMemo(
    () => [
      ...new Set(config.providers.flatMap((provider) => provider.models.map((model) => model.alias)).filter(Boolean)),
    ],
    [config.providers],
  );
  const addProvider = () =>
    setConfig((value) => ({
      ...value,
      providers: [
        ...value.providers,
        {
          name: `provider-${value.providers.length + 1}`,
          type: "openai-compatible",
          options: { base_url: "https://api.example.com/v1", api_key: "" },
          models: [{ id: "", alias: "" }],
        },
      ],
    }));
  const addScheduleRule = () =>
    setConfig((value) => ({
      ...value,
      model_schedule: {
        ...value.model_schedule,
        rules: [...value.model_schedule.rules, { start: "00:30", end: "08:30", models: { plan: "", reply: "" } }],
      },
    }));
  const updateScheduleRule = (index: number, patch: Partial<Config["model_schedule"]["rules"][number]>) =>
    setConfig((value) => ({
      ...value,
      model_schedule: {
        ...value.model_schedule,
        rules: value.model_schedule.rules.map((rule, ruleIndex) =>
          ruleIndex === index ? { ...rule, ...patch } : rule,
        ),
      },
    }));
  const updateScheduledRole = (ruleIndex: number, role: (typeof roles)[number][0], model: string) =>
    setConfig((value) => {
      const rule = value.model_schedule.rules[ruleIndex];
      if (!rule) return value;
      const models = { ...rule.models };
      if (model) models[role] = model;
      else delete models[role];
      return {
        ...value,
        model_schedule: {
          ...value.model_schedule,
          rules: value.model_schedule.rules.map((item, index) => (index === ruleIndex ? { ...item, models } : item)),
        },
      };
    });
  const fetchModels = async (index: number) => {
    const provider = config.providers[index];
    if (!provider) return;
    setLoading((value) => ({ ...value, [index]: true }));
    setErrors((value) => ({ ...value, [index]: "" }));
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: provider.type,
          base_url: provider.options.base_url,
          api_key: provider.options.api_key,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "获取模型失败");
      const models: string[] = (payload.models ?? []).filter(
        (id: unknown): id is string => typeof id === "string" && Boolean(id),
      );
      setOptions((value) => ({ ...value, [index]: [...new Set(models)] }));
    } catch (exception) {
      setErrors((value) => ({ ...value, [index]: exception instanceof Error ? exception.message : "获取模型失败" }));
    } finally {
      setLoading((value) => ({ ...value, [index]: false }));
    }
  };
  return (
    <div className="mx-auto grid max-w-[1240px] gap-5 px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5">
          <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">MODELS</p>
          <h2 className="text-lg tracking-[-0.02em]">模型分工</h2>
        </div>
        <div className="grid grid-cols-3 gap-4 max-[820px]:grid-cols-1">
          {roles.map(([key, label]) => (
            <label className="grid gap-1.75 text-xs font-700 text-[#40515f]" key={key}>
              {label}
              <Select
                value={config.models[key]}
                options={[
                  { label: "未配置", value: "" },
                  ...aliases.map((option) => ({ label: option, value: option })),
                ]}
                onChange={(model) => setConfig((value) => ({ ...value, models: { ...value.models, [key]: model } }))}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5 flex items-start justify-between gap-4">
          <div>
            <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">SCHEDULE</p>
            <h2 className="text-lg tracking-[-0.02em]">按时段切换模型</h2>
            <p className="mt-1.25 text-xs leading-[1.5] text-muted">
              按服务器本地时区匹配。命中规则时仅覆盖已选择的职责，其他职责继续使用上方默认模型。多个规则同时命中时，后面的规则优先。
            </p>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9]"
            onClick={addScheduleRule}
          >
            <Plus size={16} />
            添加时段
          </button>
        </div>
        <div className="grid gap-3.5">
          {config.model_schedule.rules.map((rule, ruleIndex) => (
            <section className="grid gap-3.5 rounded-[10px] b-ui p-4.5" key={ruleIndex}>
              <div className="flex items-end justify-between gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                    开始
                    <Input
                      type="time"
                      value={rule.start}
                      onChange={(event) => updateScheduleRule(ruleIndex, { start: event.target.value })}
                    />
                  </label>
                  <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                    结束
                    <Input
                      type="time"
                      value={rule.end}
                      onChange={(event) => updateScheduleRule(ruleIndex, { end: event.target.value })}
                    />
                  </label>
                </div>
                <button
                  aria-label="删除时段"
                  className="grid h-8.5 w-7.5 place-items-center rounded-md bg-[#edf1f3] p-0 text-[#ae3737]"
                  onClick={() =>
                    setConfig((value) => ({
                      ...value,
                      model_schedule: {
                        ...value.model_schedule,
                        rules: value.model_schedule.rules.filter((_, index) => index !== ruleIndex),
                      },
                    }))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-4 max-[820px]:grid-cols-1">
                {roles.map(([key, label]) => (
                  <label className="grid gap-1.75 text-xs font-700 text-[#40515f]" key={key}>
                    {label}
                    <Select
                      value={rule.models[key] || undefined}
                      options={[
                        { label: "保持默认", value: "" },
                        ...aliases.map((option) => ({ label: option, value: option })),
                      ]}
                      placeholder="保持默认"
                      onChange={(model) => updateScheduledRole(ruleIndex, key, model)}
                    />
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5 flex items-start justify-between gap-4">
          <div>
            <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">PROVIDERS</p>
            <h2 className="text-lg tracking-[-0.02em]">模型供应商</h2>
            <p className="mt-1.25 text-xs leading-[1.5] text-muted">填写 API 地址与密钥，并维护模型别名。</p>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9]"
            onClick={addProvider}
          >
            <Plus size={16} />
            添加供应商
          </button>
        </div>
        <Alert
          className="mb-5"
          type="info"
          message="模型配置指南"
          description={
            <details>
              <summary className="cursor-pointer text-xs font-700 text-brand">展开配置说明</summary>
              <div className="mt-2 grid gap-1">
                <p>
                  DeepSeek 官方原生端点：类型 <code>deepseek</code>，API 地址 <code>https://api.deepseek.com</code>。
                </p>
                <p>
                  DeepSeek Anthropic 端点：类型 <code>anthropic</code>，API 地址{" "}
                  <code>https://api.deepseek.com/anthropic</code>。
                </p>
                <p className="text-[#ad6800]">提示：DeepSeek 的 Anthropic 端点无法读取模型列表，请手动添加模型。</p>
              </div>
            </details>
          }
        />
        <div className="grid gap-3.5">
          {config.providers.map((provider, providerIndex) => (
            <section className="grid gap-3.5 rounded-[10px] b-ui p-4.5" key={`${provider.name}-${providerIndex}`}>
              <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  名称
                  <Input
                    value={provider.name}
                    onChange={(event) => updateProvider(providerIndex, { name: event.target.value })}
                  />
                </label>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  类型
                  <Select
                    value={provider.type}
                    options={["anthropic", "deepseek", "openai-responses", "openai-compatible"].map((type) => ({
                      label: type,
                      value: type,
                    }))}
                    onChange={(type) => updateProvider(providerIndex, { type: type as Provider["type"] })}
                  />
                </label>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  API 地址
                  <Input
                    value={provider.options.base_url}
                    onChange={(event) =>
                      updateProvider(providerIndex, {
                        options: { ...provider.options, base_url: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  API Key
                  <Input.Password
                    value={provider.options.api_key}
                    onChange={(event) =>
                      updateProvider(providerIndex, { options: { ...provider.options, api_key: event.target.value } })
                    }
                  />
                </label>
              </div>
              <div className="grid gap-3.5">
                <button
                  className="inline-flex w-fit items-center gap-1.25 bg-transparent py-0.75 text-xs font-700 text-brand disabled:cursor-wait disabled:opacity-60"
                  disabled={loading[providerIndex]}
                  onClick={() => fetchModels(providerIndex)}
                >
                  {loading[providerIndex] ? (
                    <LoaderCircle className="animate-spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  {loading[providerIndex] ? "正在获取模型" : "自动获取模型"}
                </button>
                {errors[providerIndex] && <p className="text-xs text-[#ae3737]">{errors[providerIndex]}</p>}
                {provider.models.map((model, modelIndex) => (
                  <div className="grid grid-cols-[1fr_1fr_30px] gap-1.75" key={modelIndex}>
                    <ModelPicker
                      value={model.id}
                      options={[...new Set([model.id, ...(options[providerIndex] ?? [])].filter(Boolean))]}
                      onChange={(id) =>
                        updateProvider(providerIndex, {
                          models: provider.models.map((item, index) => (index === modelIndex ? { ...item, id } : item)),
                        })
                      }
                      onSelect={(id) => {
                        if (!model.alias.trim())
                          updateProvider(providerIndex, {
                            models: provider.models.map((item, index) =>
                              index === modelIndex ? { ...item, id, alias: id } : item,
                            ),
                          });
                      }}
                    />
                    <Input
                      className="font-mono text-xs"
                      value={model.alias}
                      placeholder="模型别名"
                      onChange={(event) =>
                        updateProvider(providerIndex, {
                          models: provider.models.map((item, index) =>
                            index === modelIndex ? { ...item, alias: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <button
                      className="grid h-8.5 w-7.5 place-items-center rounded-md bg-[#edf1f3] p-0 text-[#526574]"
                      onClick={() =>
                        updateProvider(providerIndex, {
                          models: provider.models.filter((_, index) => index !== modelIndex),
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
                <button
                  className="inline-flex w-fit items-center gap-1.25 bg-transparent py-0.75 text-xs font-700 text-brand"
                  onClick={() => updateProvider(providerIndex, { models: [...provider.models, { id: "", alias: "" }] })}
                >
                  <Plus size={15} />
                  添加模型
                </button>
              </div>
              <button
                className="inline-flex w-fit items-center gap-1.25 bg-transparent py-0.75 text-xs font-700 text-[#ae3737]"
                onClick={() =>
                  setConfig((value) => ({
                    ...value,
                    providers: value.providers.filter((_, index) => index !== providerIndex),
                  }))
                }
              >
                <Trash2 size={15} />
                删除供应商
              </button>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
