import { useEffect, useState } from "react";
import { GaugeIcon, LoaderCircleIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { QueueLoopVisualizer } from "@/components/QueueLoopVisualizer";

type BotConfig = Record<string, unknown> & {
  max_queue: number;
  debounce_ms: number;
};

type RuntimeSettings = {
  maxQueue: string;
  debounceMs: string;
};

function getErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = data.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") {
    return fallback;
  }
  return error.message;
}

function getIntegerError(value: string, min: number, max?: number) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) {
    return "请输入整数";
  }

  const number = Number(normalized);
  if (number < min) return `不能小于 ${min}`;
  if (max !== undefined && number > max) return `不能大于 ${max}`;
  return undefined;
}

export function RuntimeSettingsPage() {
  const [config, setConfig] = useState<BotConfig>();
  const [settings, setSettings] = useState<RuntimeSettings>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载消息循环设置"));
        if (!data || typeof data !== "object") throw new Error("配置格式不正确");

        const nextConfig = data as BotConfig;
        setConfig(nextConfig);
        setSettings({ maxQueue: String(nextConfig.max_queue), debounceMs: String(nextConfig.debounce_ms) });
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "无法加载消息循环设置");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadConfig();
    return () => controller.abort();
  }, []);

  const maxQueueError = settings ? getIntegerError(settings.maxQueue, 1) : undefined;
  const debounceMsError = settings ? getIntegerError(settings.debounceMs, 1000, 10000) : undefined;
  const isInvalid = Boolean(maxQueueError || debounceMsError);

  async function saveConfig(restart = false) {
    if (!config || !settings || isInvalid || isSaving) return;

    const nextConfig: BotConfig = {
      ...config,
      max_queue: Number(settings.maxQueue),
      debounce_ms: Number(settings.debounceMs),
    };
    setIsSaving(true);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextConfig),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(data, "保存消息循环设置失败"));
      setConfig(nextConfig);

      if (!restart) {
        toast.success("消息循环设置已保存，重启后生效");
        return;
      }

      const restartResponse = await fetch("/api/runtime/restart", { method: "POST" });
      const restartData = await restartResponse.json().catch(() => undefined);
      if (!restartResponse.ok) throw new Error(getErrorMessage(restartData, "重启服务失败"));
      toast.success("配置已保存，服务正在重启");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存消息循环设置失败");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <section className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        正在加载消息循环
      </section>
    );
  }

  if (!config || !settings) {
    return (
      <section className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        配置加载失败，请刷新后重试。
      </section>
    );
  }

  const previewMaxQueue = maxQueueError ? config.max_queue : Number(settings.maxQueue);
  const previewDebounceMs = debounceMsError ? config.debounce_ms : Number(settings.debounceMs);

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">消息循环</h1>
          <p className="text-sm text-muted-foreground">观察消息如何被收集、评估并合并成一次代理调用。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void saveConfig()} disabled={isInvalid || isSaving}>
            <SaveIcon data-icon="inline-start" />
            保存配置
          </Button>
          <Button onClick={() => void saveConfig(true)} disabled={isInvalid || isSaving}>
            {isSaving ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            保存并重启
          </Button>
        </div>
      </div>

      <Card size="sm">
        <CardHeader className="border-b sm:flex sm:items-center sm:gap-3">
          <CardTitle className="flex items-center gap-2">
            <GaugeIcon className="size-4" />
            循环参数
          </CardTitle>
          <CardDescription>修改后立即应用到下方模拟器；保存后的服务配置需重启生效。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-3 md:grid-cols-2">
            <Field
              className="gap-1.5 sm:grid sm:grid-cols-[10rem_1fr] sm:items-center"
              data-invalid={Boolean(maxQueueError)}
            >
              <FieldLabel htmlFor="max-queue">消息队列上限</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="max-queue"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  aria-invalid={Boolean(maxQueueError)}
                  value={settings.maxQueue}
                  onChange={(event) => setSettings({ ...settings, maxQueue: event.target.value })}
                />
                <InputGroupAddon align="inline-end">条</InputGroupAddon>
              </InputGroup>
              <FieldDescription className="text-xs sm:col-span-2">
                每个会话最多保留的待处理消息数，超出时丢弃最早的消息。
              </FieldDescription>
              <FieldError className="sm:col-span-2">{maxQueueError}</FieldError>
            </Field>

            <Field
              className="gap-1.5 sm:grid sm:grid-cols-[10rem_1fr] sm:items-center"
              data-invalid={Boolean(debounceMsError)}
            >
              <FieldLabel htmlFor="debounce-ms">消息合并等待时间</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="debounce-ms"
                  type="number"
                  inputMode="numeric"
                  min={1000}
                  max={10000}
                  step={100}
                  aria-invalid={Boolean(debounceMsError)}
                  value={settings.debounceMs}
                  onChange={(event) => setSettings({ ...settings, debounceMs: event.target.value })}
                />
                <InputGroupAddon align="inline-end">毫秒</InputGroupAddon>
              </InputGroup>
              <FieldDescription className="text-xs sm:col-span-2">
                收到最后一条消息后等待多久再评估处理，1秒~10秒。
              </FieldDescription>
              <FieldError className="sm:col-span-2">{debounceMsError}</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <QueueLoopVisualizer maxQueue={previewMaxQueue} debounceMs={previewDebounceMs} />
    </section>
  );
}
