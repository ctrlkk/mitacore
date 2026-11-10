import { useEffect, useState } from "react";
import { GaugeIcon, LoaderCircleIcon, RefreshCwIcon, SaveIcon, ScissorsIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { QueueLoopVisualizer } from "@/components/QueueLoopVisualizer";

type BotConfig = Record<string, unknown> & {
  max_queue: number;
  debounce_ms: number;
  preprocess_group_media: boolean;
  splitter?: SplitterConfig;
};

type SplitterConfig = {
  enable: boolean;
  max_length: number;
  max_sentence_num: number;
  max_split_num: number;
  remove_bracketed_narration: boolean;
  enable_overflow_return_all: boolean;
};

type RuntimeSettings = {
  maxQueue: string;
  debounceMs: string;
  preprocessGroupMedia: boolean;
  splitter: Omit<SplitterConfig, "max_length" | "max_sentence_num" | "max_split_num"> & {
    maxLength: string;
    maxSentenceNum: string;
    maxSplitNum: string;
  };
};

const defaultSplitterConfig: SplitterConfig = {
  enable: true,
  max_length: 512,
  max_sentence_num: 10,
  max_split_num: 3,
  remove_bracketed_narration: true,
  enable_overflow_return_all: true,
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
        const splitter = nextConfig.splitter ?? defaultSplitterConfig;
        setConfig(nextConfig);
        setSettings({
          maxQueue: String(nextConfig.max_queue),
          debounceMs: String(nextConfig.debounce_ms),
          preprocessGroupMedia: nextConfig.preprocess_group_media ?? true,
          splitter: {
            enable: splitter.enable,
            maxLength: String(splitter.max_length),
            maxSentenceNum: String(splitter.max_sentence_num),
            maxSplitNum: String(splitter.max_split_num),
            remove_bracketed_narration: splitter.remove_bracketed_narration ?? true,
            enable_overflow_return_all: splitter.enable_overflow_return_all,
          },
        });
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
  const maxLengthError = settings ? getIntegerError(settings.splitter.maxLength, 1) : undefined;
  const maxSentenceNumError = settings ? getIntegerError(settings.splitter.maxSentenceNum, 1) : undefined;
  const maxSplitNumError = settings ? getIntegerError(settings.splitter.maxSplitNum, 1) : undefined;
  const isInvalid = Boolean(
    maxQueueError || debounceMsError || maxLengthError || maxSentenceNumError || maxSplitNumError,
  );

  async function saveConfig(restart = false) {
    if (!config || !settings || isInvalid || isSaving) return;

    const nextConfig: BotConfig = {
      ...config,
      max_queue: Number(settings.maxQueue),
      debounce_ms: Number(settings.debounceMs),
      preprocess_group_media: settings.preprocessGroupMedia,
      splitter: {
        enable: settings.splitter.enable,
        max_length: Number(settings.splitter.maxLength),
        max_sentence_num: Number(settings.splitter.maxSentenceNum),
        max_split_num: Number(settings.splitter.maxSplitNum),
        remove_bracketed_narration: settings.splitter.remove_bracketed_narration,
        enable_overflow_return_all: settings.splitter.enable_overflow_return_all,
      },
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
          <p className="text-sm text-muted-foreground">配置消息处理和回复拆分，并观察消息如何合并成一次代理调用。</p>
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
          <CardDescription>队列上限与等待时间会立即应用到下方模拟器；保存后的服务配置需重启生效。</CardDescription>
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

            <Field orientation="horizontal" className="rounded-lg border p-3 md:col-span-2">
              <FieldContent>
                <FieldLabel htmlFor="preprocess-group-media">群聊媒体即时预处理</FieldLabel>
                <FieldDescription className="text-xs">
                  关闭后，群聊中的图片、视频和音频仅在消息触发回复时下载并转述；私聊不受影响。
                </FieldDescription>
              </FieldContent>
              <Switch
                id="preprocess-group-media"
                checked={settings.preprocessGroupMedia}
                onCheckedChange={(checked) => setSettings({ ...settings, preprocessGroupMedia: checked })}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="border-b sm:flex sm:items-center sm:gap-3">
          <CardTitle className="flex items-center gap-2">
            <ScissorsIcon className="size-4" />
            回复拆分
          </CardTitle>
          <CardDescription>控制回复文本的分段方式；保存后重启服务生效。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-3 md:grid-cols-2">
            <Field orientation="horizontal" className="rounded-lg border p-3 md:col-span-2">
              <FieldContent>
                <FieldLabel htmlFor="splitter-enable">启用回复拆分</FieldLabel>
                <FieldDescription className="text-xs">关闭后不再分段，括号旁白清洗仍由独立开关控制。</FieldDescription>
              </FieldContent>
              <Switch
                id="splitter-enable"
                checked={settings.splitter.enable}
                onCheckedChange={(checked) =>
                  setSettings({ ...settings, splitter: { ...settings.splitter, enable: checked } })
                }
              />
            </Field>

            <Field
              className="gap-1.5 sm:grid sm:grid-cols-[10rem_1fr] sm:items-center"
              data-invalid={Boolean(maxLengthError)}
            >
              <FieldLabel htmlFor="splitter-max-length">分段长度基准</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="splitter-max-length"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  aria-invalid={Boolean(maxLengthError)}
                  value={settings.splitter.maxLength}
                  onChange={(event) =>
                    setSettings({ ...settings, splitter: { ...settings.splitter, maxLength: event.target.value } })
                  }
                />
                <InputGroupAddon align="inline-end">字符</InputGroupAddon>
              </InputGroup>
              <FieldDescription className="text-xs sm:col-span-2">
                主要为中文且总长度超过该值两倍时，返回默认短句。
              </FieldDescription>
              <FieldError className="sm:col-span-2">{maxLengthError}</FieldError>
            </Field>

            <Field
              className="gap-1.5 sm:grid sm:grid-cols-[10rem_1fr] sm:items-center"
              data-invalid={Boolean(maxSentenceNumError)}
            >
              <FieldLabel htmlFor="splitter-max-sentence-num">最多句数</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="splitter-max-sentence-num"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  aria-invalid={Boolean(maxSentenceNumError)}
                  value={settings.splitter.maxSentenceNum}
                  onChange={(event) =>
                    setSettings({ ...settings, splitter: { ...settings.splitter, maxSentenceNum: event.target.value } })
                  }
                />
                <InputGroupAddon align="inline-end">句</InputGroupAddon>
              </InputGroup>
              <FieldDescription className="text-xs sm:col-span-2">超出此句数时按下方溢出策略处理。</FieldDescription>
              <FieldError className="sm:col-span-2">{maxSentenceNumError}</FieldError>
            </Field>

            <Field
              className="gap-1.5 sm:grid sm:grid-cols-[10rem_1fr] sm:items-center"
              data-invalid={Boolean(maxSplitNumError)}
            >
              <FieldLabel htmlFor="splitter-max-split-num">最多拆分段数</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="splitter-max-split-num"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  aria-invalid={Boolean(maxSplitNumError)}
                  value={settings.splitter.maxSplitNum}
                  onChange={(event) =>
                    setSettings({ ...settings, splitter: { ...settings.splitter, maxSplitNum: event.target.value } })
                  }
                />
                <InputGroupAddon align="inline-end">段</InputGroupAddon>
              </InputGroup>
              <FieldDescription className="text-xs sm:col-span-2">回复时的分段上限。</FieldDescription>
              <FieldError className="sm:col-span-2">{maxSplitNumError}</FieldError>
            </Field>

            <Field orientation="horizontal" className="rounded-lg border p-3 md:col-span-2">
              <FieldContent>
                <FieldLabel htmlFor="splitter-remove-bracketed-narration">移除括号旁白</FieldLabel>
                <FieldDescription className="text-xs">移除（中文旁白）和[中文旁白]；关闭后保留原文。</FieldDescription>
              </FieldContent>
              <Switch
                id="splitter-remove-bracketed-narration"
                checked={settings.splitter.remove_bracketed_narration}
                onCheckedChange={(checked) =>
                  setSettings({
                    ...settings,
                    splitter: { ...settings.splitter, remove_bracketed_narration: checked },
                  })
                }
              />
            </Field>

            <Field orientation="horizontal" className="rounded-lg border p-3 md:col-span-2">
              <FieldContent>
                <FieldLabel htmlFor="splitter-overflow-return-all">句数超限时返回全文</FieldLabel>
                <FieldDescription className="text-xs">关闭后，句数超限时改为返回默认短句。</FieldDescription>
              </FieldContent>
              <Switch
                id="splitter-overflow-return-all"
                checked={settings.splitter.enable_overflow_return_all}
                onCheckedChange={(checked) =>
                  setSettings({
                    ...settings,
                    splitter: { ...settings.splitter, enable_overflow_return_all: checked },
                  })
                }
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <QueueLoopVisualizer maxQueue={previewMaxQueue} debounceMs={previewDebounceMs} />
    </section>
  );
}
