import { LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ModelPicker } from "../components/ModelPicker";
import type { Config, Provider } from "../types";

type Props = {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  updateProvider: (index: number, patch: Partial<Provider>) => void;
};
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
    <div className="content">
      <section className="card">
        <div className="card-heading provider-heading">
          <div>
            <p className="eyebrow">PROVIDERS</p>
            <h2>模型供应商</h2>
            <p>填写 API 地址与密钥，并维护模型别名。</p>
          </div>
          <button className="button secondary" onClick={addProvider}>
            <Plus size={16} />
            添加供应商
          </button>
        </div>
        <div className="provider-list">
          {config.providers.map((provider, providerIndex) => (
            <section className="provider-card" key={`${provider.name}-${providerIndex}`}>
              <div className="provider-fields">
                <label className="field">
                  名称
                  <input
                    value={provider.name}
                    onChange={(event) => updateProvider(providerIndex, { name: event.target.value })}
                  />
                </label>
                <label className="field">
                  类型
                  <select
                    value={provider.type}
                    onChange={(event) =>
                      updateProvider(providerIndex, { type: event.target.value as Provider["type"] })
                    }
                  >
                    {["anthropic", "deepseek", "openai-responses", "openai-compatible"].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  API 地址
                  <input
                    value={provider.options.base_url}
                    onChange={(event) =>
                      updateProvider(providerIndex, { options: { ...provider.options, base_url: event.target.value } })
                    }
                  />
                </label>
                <label className="field">
                  API Key
                  <input
                    type="password"
                    value={provider.options.api_key}
                    onChange={(event) =>
                      updateProvider(providerIndex, { options: { ...provider.options, api_key: event.target.value } })
                    }
                  />
                </label>
              </div>
              <div className="provider-models">
                <button
                  className="text-button"
                  disabled={loading[providerIndex]}
                  onClick={() => fetchModels(providerIndex)}
                >
                  {loading[providerIndex] ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  {loading[providerIndex] ? "正在获取模型" : "自动获取模型"}
                </button>
                {errors[providerIndex] && <p className="provider-error">{errors[providerIndex]}</p>}
                {provider.models.map((model, modelIndex) => (
                  <div className="model-row" key={modelIndex}>
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
                    <input
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
                      className="icon-button"
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
                  className="text-button"
                  onClick={() => updateProvider(providerIndex, { models: [...provider.models, { id: "", alias: "" }] })}
                >
                  <Plus size={15} />
                  添加模型
                </button>
              </div>
              <button
                className="text-button danger-text"
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
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">MODELS</p>
            <h2>模型分工</h2>
          </div>
        </div>
        <div className="model-grid">
          {(
            [
              ["plan", "规划"],
              ["reply", "回复"],
              ["main", "主 Agent"],
              ["task_explore", "Task 检索子 Agent"],
              ["task_general", "Task 通用子 Agent"],
              ["multimodal_image", "图像理解"],
              ["multimodal_video", "视频理解"],
              ["multimodal_audio", "音频理解"],
            ] as const
          ).map(([key, label]) => (
            <label className="field" key={key}>
              {label}
              <select
                value={config.models[key]}
                onChange={(event) =>
                  setConfig((value) => ({ ...value, models: { ...value.models, [key]: event.target.value } }))
                }
              >
                <option value="">未配置</option>
                {aliases.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
