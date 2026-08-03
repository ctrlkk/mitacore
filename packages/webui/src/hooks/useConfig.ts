import { useEffect, useState } from "react";
import { defaultConfig, type Config, type Provider } from "../types";

export function useConfig() {
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) throw new Error("加载配置失败");
        return response.json();
      })
      .then(setConfig)
      .catch((exception) => setError(exception instanceof Error ? exception.message : "加载配置失败"))
      .finally(() => setLoading(false));
  }, []);
  const saveConfig = async () => {
    setSaveState("saving");
    setError("");
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "保存失败");
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 2500);
    } catch (exception) {
      setSaveState("error");
      setError(exception instanceof Error ? exception.message : "保存失败");
    }
  };
  const updateProvider = (index: number, patch: Partial<Provider>) =>
    setConfig((value) => ({
      ...value,
      providers: value.providers.map((provider, providerIndex) =>
        providerIndex === index ? { ...provider, ...patch } : provider,
      ),
    }));
  return { config, setConfig, loading, error, saveState, saveConfig, updateProvider };
}
