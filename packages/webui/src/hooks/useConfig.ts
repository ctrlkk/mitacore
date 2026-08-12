import { useCallback, useEffect, useRef, useState } from "react";
import { defaultConfig, type Config, type Provider } from "@/types";

export function useConfig() {
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [restartState, setRestartState] = useState<"idle" | "restarting" | "error">("idle");
  const restartTimer = useRef<number | undefined>(undefined);
  const reloadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config");
      if (!response.ok) throw new Error("加载配置失败");
      setConfig((await response.json()) as Config);
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "加载配置失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reloadConfig();
  }, [reloadConfig]);
  useEffect(() => {
    return () => {
      if (restartTimer.current !== undefined) window.clearTimeout(restartTimer.current);
    };
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
  const waitForRestart = async (attempt = 0): Promise<void> => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (response.ok) {
        setRestartState("idle");
        await reloadConfig();
        return;
      }
    } catch {
      // bot 重启期间 WebUI 暂时不可用，继续等待。
    }
    if (attempt >= 60) {
      setRestartState("error");
      setError("重启超时，请检查桌面应用是否仍在运行");
      return;
    }
    restartTimer.current = window.setTimeout(() => void waitForRestart(attempt + 1), 500);
  };
  const restart = async () => {
    setRestartState("restarting");
    setError("");
    try {
      const response = await fetch("/api/restart", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "重启失败");
      restartTimer.current = window.setTimeout(() => void waitForRestart(), 500);
    } catch {
      // 进程可能在响应返回前退出，先检查服务是否已经重新启动。
      restartTimer.current = window.setTimeout(() => void waitForRestart(), 500);
    }
  };
  const updateProvider = (index: number, patch: Partial<Provider>) =>
    setConfig((value) => ({
      ...value,
      providers: value.providers.map((provider, providerIndex) =>
        providerIndex === index ? { ...provider, ...patch } : provider,
      ),
    }));
  return {
    config,
    setConfig,
    loading,
    error,
    saveState,
    saveConfig,
    restartState,
    restart,
    updateProvider,
    reloadConfig,
  };
}
