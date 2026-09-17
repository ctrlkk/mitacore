import { useEffect, useId, useRef, useState } from "react";
import anthropicIcon from "@/assets/provider-icons/anthropic.svg";
import bailianIcon from "@/assets/provider-icons/bailian.svg";
import deepseekIcon from "@/assets/provider-icons/deepseek.svg";
import googleIcon from "@/assets/provider-icons/google.svg";
import mimoIcon from "@/assets/provider-icons/mimo.svg";
import minimaxIcon from "@/assets/provider-icons/minimax.svg";
import openaiIcon from "@/assets/provider-icons/openai.svg";
import zhipuIcon from "@/assets/provider-icons/zhipu.svg";
import {
  BrainCircuitIcon,
  CheckIcon,
  Clock3Icon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type ModelRole =
  | "plan"
  | "reply"
  | "main"
  | "task_explore"
  | "task_general"
  | "multimodal_image"
  | "multimodal_video"
  | "multimodal_audio";

type ProviderType = "anthropic" | "google" | "openai-responses" | "openai-compatible" | "deepseek";

type ReasoningLevel = "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ModelOptions = {
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop_sequences?: string[];
  seed?: number;
  reasoning?: ReasoningLevel;
  provider_options?: Record<string, unknown>;
};

type ModelNumberOptionKey = Exclude<keyof ModelOptions, "stop_sequences" | "reasoning" | "provider_options">;

type ModelProvider = {
  name: string;
  type: ProviderType;
  options: { base_url: string; api_key: string };
  models: Array<{ id: string; alias: string; options?: ModelOptions }>;
};

type ScheduleRule = {
  start: string;
  end: string;
  models: Partial<Record<ModelRole, string>>;
};

type BotConfig = Record<string, unknown> & {
  providers: ModelProvider[];
  models: Record<ModelRole, string>;
  model_schedule: { rules: ScheduleRule[] };
};

const roleDefinitions: Array<{ key: ModelRole; label: string; description: string }> = [
  { key: "plan", label: "规划", description: "调用工具并制定回复策略" },
  { key: "reply", label: "回复", description: "根据规划生成并发送回复" },
  { key: "main", label: "主代理", description: "单代理模式下执行并直接回复" },
  { key: "task_explore", label: "探索子代理", description: "只读检索与信息探索" },
  { key: "task_general", label: "通用子代理", description: "处理可读写的多步骤任务" },
  { key: "multimodal_image", label: "图像理解", description: "将图片转为文字描述" },
  { key: "multimodal_video", label: "视频理解", description: "将视频转为文字描述" },
  { key: "multimodal_audio", label: "音频理解", description: "转写并理解音频内容" },
];

const providerTypes: Array<{ value: ProviderType; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google Gemini" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
  { value: "deepseek", label: "DeepSeek" },
];

const reasoningLevels: Array<{ value: ReasoningLevel; label: string }> = [
  { value: "provider-default", label: "供应商默认" },
  { value: "none", label: "关闭推理" },
  { value: "minimal", label: "最低 (minimal)" },
  { value: "low", label: "低 (low)" },
  { value: "medium", label: "中 (medium)" },
  { value: "high", label: "高 (high)" },
  { value: "xhigh", label: "极高 (xhigh)" },
];

const modelNumberFields: Array<{
  key: ModelNumberOptionKey;
  label: string;
  description: string;
  step?: number | "any";
  validate?: (value: number) => string | undefined;
}> = [
  {
    key: "max_output_tokens",
    label: "最大输出 Tokens",
    description: "限制单次生成的最大输出长度。",
    step: 1,
    validate: (value) => (Number.isInteger(value) && value > 0 ? undefined : "请输入大于 0 的整数"),
  },
  { key: "temperature", label: "Temperature", description: "控制输出随机性，范围由供应商决定。" },
  {
    key: "top_p",
    label: "Top P",
    description: "Nucleus sampling 参数，取值 0 到 1。",
    validate: (value) => (value >= 0 && value <= 1 ? undefined : "请输入 0 到 1 之间的数字"),
  },
  {
    key: "top_k",
    label: "Top K",
    description: "每次采样参与候选的 token 数量。",
    step: 1,
    validate: (value) => (Number.isInteger(value) && value > 0 ? undefined : "请输入大于 0 的整数"),
  },
  { key: "presence_penalty", label: "Presence Penalty", description: "降低已出现内容再次出现的倾向。" },
  { key: "frequency_penalty", label: "Frequency Penalty", description: "根据出现频率降低重复内容。" },
  {
    key: "seed",
    label: "Seed",
    description: "用于可复现采样的整数随机种子。",
    step: 1,
    validate: (value) => (Number.isInteger(value) ? undefined : "请输入整数"),
  },
];

const providerIconPaths: Record<Exclude<ProviderType, "openai-responses" | "openai-compatible">, string> = {
  anthropic: anthropicIcon,
  google: googleIcon,
  deepseek: deepseekIcon,
};

const providerPresets: Array<{
  value: string;
  label: string;
  description: string;
  logo: string;
  provider: ModelProvider;
}> = [
  {
    value: "mimo",
    label: "小米 MiMo",
    description: "OpenAI 兼容接口，包含通用与多模态模型。",
    logo: mimoIcon,
    provider: {
      name: "小米 MiMo",
      type: "openai-compatible",
      options: { base_url: "https://api.xiaomimimo.com/v1", api_key: "" },
      models: [
        { id: "mimo-v2.5-pro", alias: "mimo-v2.5-pro" },
        { id: "mimo-v2.5", alias: "mimo-v2.5" },
      ],
    },
  },
  {
    value: "aliyun-bailian",
    label: "阿里云百炼",
    description: "OpenAI Responses 兼容接口，使用北京地域通用地址。",
    logo: bailianIcon,
    provider: {
      name: "阿里云百炼",
      type: "openai-responses",
      options: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key: "",
      },
      models: [
        { id: "qwen3.7-plus", alias: "qwen3.7-plus" },
        { id: "qwen3.8-max", alias: "qwen3.8-max" },
        { id: "qwen3.7-flash", alias: "qwen3.7-flash" },
      ],
    },
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek 官方接口。",
    logo: deepseekIcon,
    provider: {
      name: "DeepSeek",
      type: "deepseek",
      options: { base_url: "https://api.deepseek.com", api_key: "" },
      models: [
        { id: "deepseek-v4-flash", alias: "deepseek-v4-flash" },
        { id: "deepseek-v4-pro", alias: "deepseek-v4-pro" },
        { id: "deepseek-v4-flash-vision-exp", alias: "deepseek-v4-flash-vision-exp" },
      ],
    },
  },
  {
    value: "zhipu",
    label: "智谱 AI",
    description: "OpenAI 兼容接口。",
    logo: zhipuIcon,
    provider: {
      name: "智谱 AI",
      type: "openai-compatible",
      options: { base_url: "https://open.bigmodel.cn/api/paas/v4", api_key: "" },
      models: [
        { id: "glm-5.3", alias: "glm-5.3" },
        { id: "glm-5.3-flash", alias: "glm-5.3-flash" },
      ],
    },
  },
  {
    value: "minimax",
    label: "MiniMax",
    description: "Anthropic Messages 兼容接口。",
    logo: minimaxIcon,
    provider: {
      name: "MiniMax",
      type: "anthropic",
      options: { base_url: "https://api.minimaxi.com/anthropic", api_key: "" },
      models: [{ id: "MiniMax-M3", alias: "MiniMax-M3" }],
    },
  },
];

function getErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = data.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string")
    return fallback;
  return error.message;
}

async function getResponseError(response: Response, fallback: string) {
  return getErrorMessage(await response.json().catch(() => undefined), fallback);
}

function getOptionalNumberError(input: string, validate?: (value: number) => string | undefined): string | undefined {
  if (!input.trim()) return undefined;
  const value = Number(input);
  if (!Number.isFinite(value)) return "请输入有效数字";
  return validate?.(value);
}

function parseProviderOptions(input: string): {
  value?: Record<string, unknown>;
  error?: string;
} {
  if (!input.trim()) return {};
  try {
    const value: unknown = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "请输入 JSON 对象" };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: "JSON 格式不正确" };
  }
}

function getModelOptionCount(options?: ModelOptions) {
  return options ? Object.keys(options).length : 0;
}

function createProvider(): ModelProvider {
  return {
    name: "新供应商",
    type: "openai-compatible",
    options: { base_url: "", api_key: "" },
    models: [{ id: "", alias: "" }],
  };
}

function createProviderFromPreset(provider: ModelProvider): ModelProvider {
  return structuredClone(provider);
}

function getProviderEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return baseUrl || "尚未配置地址";
  }
}

export function ModelConfigPage() {
  const [config, setConfig] = useState<BotConfig>();
  const [savedConfig, setSavedConfig] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editor, setEditor] = useState<{ index: number | null; provider: ModelProvider }>();
  const [isPresetPickerOpen, setIsPresetPickerOpen] = useState(false);
  const [providerToDelete, setProviderToDelete] = useState<{ index: number; name: string }>();
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        if (!response.ok) throw new Error(await getResponseError(response, "无法加载配置"));
        const loadedConfig = (await response.json()) as BotConfig;
        setConfig(loadedConfig);
        setSavedConfig(JSON.stringify(loadedConfig));
      } catch (error) {
        if (!controller.signal.aborted) {
          toast.error(error instanceof Error ? error.message : "无法加载配置");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadConfig();
    return () => controller.abort();
  }, []);

  const modelAliases = [
    ...new Set(config?.providers.flatMap((provider) => provider.models.map((model) => model.alias)) ?? []),
  ].filter(Boolean);
  const serializedConfig = config ? JSON.stringify(config) : undefined;
  const hasUnsavedChanges = savedConfig !== undefined && serializedConfig !== savedConfig;

  function updateConfig(update: (current: BotConfig) => BotConfig) {
    setConfig((current) => (current ? update(current) : current));
  }

  function updateModel(role: ModelRole, alias: string) {
    updateConfig((current) => ({ ...current, models: { ...current.models, [role]: alias } }));
  }

  function updateScheduleRule(index: number, update: (rule: ScheduleRule) => ScheduleRule) {
    updateConfig((current) => ({
      ...current,
      model_schedule: {
        ...current.model_schedule,
        rules: current.model_schedule.rules.map((rule, ruleIndex) => (ruleIndex === index ? update(rule) : rule)),
      },
    }));
  }

  async function saveConfig() {
    if (!config) return;
    const configToSave = JSON.stringify(config);
    setIsSaving(true);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: configToSave,
      });
      if (!response.ok) throw new Error(await getResponseError(response, "保存配置失败"));
      setSavedConfig(configToSave);
      toast.success("模型配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存配置失败");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <section className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        <LoaderCircleIcon className="size-5 animate-spin" />
        <span className="ml-2">正在加载模型配置</span>
      </section>
    );
  }

  if (!config) {
    return (
      <section className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        配置加载失败，请刷新后重试。
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-8 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">模型配置</h1>
          <p className="text-sm text-muted-foreground">为各职责、时段和供应商配置可用模型。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge
            variant={hasUnsavedChanges ? "outline" : "secondary"}
            className={
              hasUnsavedChanges
                ? "h-7 border-amber-500/50 bg-amber-500/10 px-2.5 text-amber-700 dark:text-amber-400"
                : "h-7 px-2.5 text-muted-foreground"
            }
            role="status"
            aria-live="polite"
          >
            {hasUnsavedChanges ? (
              <span className="size-2 rounded-full bg-amber-500" />
            ) : (
              <CheckIcon data-icon="inline-start" />
            )}
            {hasUnsavedChanges ? "有未保存的更改" : "配置已保存"}
          </Badge>
          <Button ref={saveButtonRef} onClick={saveConfig} disabled={isSaving || !hasUnsavedChanges}>
            {isSaving ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            {isSaving ? "正在保存" : "保存配置"}
          </Button>
        </div>
      </div>

      <section aria-labelledby="model-roles-title" className="rounded-xl border bg-card">
        <div className="flex flex-col gap-1 border-b px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2">
            <BrainCircuitIcon className="size-4" />
            <h2 id="model-roles-title" className="font-semibold">
              模型分工
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">设置每个系统职责默认使用的模型别名。</p>
        </div>
        <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
          {roleDefinitions.map((role) => (
            <label key={role.key} className="flex min-w-0 flex-col gap-1.5 p-3 sm:p-4">
              <span className="text-sm font-medium">{role.label}</span>
              <span className="text-xs leading-5 text-muted-foreground">{role.description}</span>
              <ModelAliasCombobox
                value={config.models[role.key]}
                aliases={modelAliases}
                onChange={(value) => updateModel(role.key, value)}
              />
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="model-schedule-title" className="rounded-xl border bg-card">
        <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Clock3Icon className="size-4" />
              <h2 id="model-schedule-title" className="font-semibold">
                按时段切换
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              按服务器本地时区匹配，时段内填写的职责会覆盖上方的默认分工。
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              updateConfig((current) => ({
                ...current,
                model_schedule: {
                  ...current.model_schedule,
                  rules: [...current.model_schedule.rules, { start: "00:00", end: "08:00", models: {} }],
                },
              }))
            }
          >
            <PlusIcon data-icon="inline-start" />
            添加时段
          </Button>
        </div>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          {config.model_schedule.rules.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              尚未设置时段覆盖规则。
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {config.model_schedule.rules.map((rule, index) => (
                <section key={index} className="rounded-lg border p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-2 text-sm font-medium">
                        开始
                        <Input
                          type="time"
                          value={rule.start}
                          onChange={(event) =>
                            updateScheduleRule(index, (current) => ({ ...current, start: event.target.value }))
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-2 text-sm font-medium">
                        结束
                        <Input
                          type="time"
                          value={rule.end}
                          onChange={(event) =>
                            updateScheduleRule(index, (current) => ({ ...current, end: event.target.value }))
                          }
                        />
                      </label>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateConfig((current) => ({
                          ...current,
                          model_schedule: {
                            ...current.model_schedule,
                            rules: current.model_schedule.rules.filter((_, ruleIndex) => ruleIndex !== index),
                          },
                        }))
                      }
                    >
                      <Trash2Icon data-icon="inline-start" />
                      删除时段
                    </Button>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {roleDefinitions.map((role) => (
                      <label key={role.key} className="flex min-w-0 flex-col gap-1.5 text-sm">
                        <span className="font-medium">{role.label}</span>
                        <ModelAliasCombobox
                          value={rule.models[role.key] ?? ""}
                          aliases={modelAliases}
                          emptyLabel="不覆盖"
                          onChange={(value) =>
                            updateScheduleRule(index, (current) => {
                              const models = { ...current.models };
                              if (value) models[role.key] = value;
                              else delete models[role.key];
                              return { ...current, models };
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="providers-title" className="rounded-xl border bg-card">
        <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-col gap-1">
            <h2 id="providers-title" className="font-semibold">
              模型供应商
            </h2>
            <p className="text-sm text-muted-foreground">模型别名在分工和时段配置中作为稳定引用使用。</p>
          </div>
          <Button variant="outline" onClick={() => setIsPresetPickerOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            添加供应商
          </Button>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
          {config.providers.map((provider, providerIndex) => (
            <Card key={providerIndex} size="sm" className="min-w-0">
              <CardHeader>
                <CardTitle className="truncate">{provider.name}</CardTitle>
                <CardDescription className="truncate text-xs">
                  {getProviderEndpoint(provider.options.base_url)}
                </CardDescription>
                <CardAction>
                  <ProviderTypeBadge type={provider.type} />
                </CardAction>
              </CardHeader>
              <CardContent className="flex min-h-6 flex-wrap gap-1.5">
                {provider.models.slice(0, 4).map((model) => (
                  <Badge key={model.alias} variant="outline" className="max-w-full truncate">
                    {model.alias || "未命名模型"}
                  </Badge>
                ))}
                {provider.models.length > 4 ? (
                  <Badge variant="outline" className="text-muted-foreground">
                    + {provider.models.length - 4}
                  </Badge>
                ) : null}
              </CardContent>
              <CardFooter className="mt-auto justify-end gap-2">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`编辑供应商 ${provider.name}`}
                  onClick={() => setEditor({ index: providerIndex, provider: structuredClone(provider) })}
                >
                  <PencilIcon data-icon="inline-start" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`删除供应商 ${provider.name}`}
                  onClick={() => setProviderToDelete({ index: providerIndex, name: provider.name })}
                >
                  <Trash2Icon data-icon="inline-start" />
                </Button>
              </CardFooter>
            </Card>
          ))}
          {config.providers.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">
              尚未添加模型供应商。
            </p>
          ) : null}
        </div>
      </section>
      {hasUnsavedChanges ? (
        <div className="pointer-events-none fixed right-4 bottom-4 z-40">
          <Button
            variant="outline"
            className="pointer-events-auto border-amber-500/50 bg-background/95 text-amber-700 shadow-lg backdrop-blur hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
            aria-label="有未保存的更改，前往保存按钮"
            onClick={() => saveButtonRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
          >
            {isSaving ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <span className="size-2 rounded-full bg-amber-500" />
            )}
            <span role="status" aria-live="polite">
              {isSaving ? "正在保存" : "未保存"}
            </span>
          </Button>
        </div>
      ) : null}
      <ProviderPresetPicker
        open={isPresetPickerOpen}
        onClose={() => setIsPresetPickerOpen(false)}
        onSelect={(provider) => {
          setEditor({ index: null, provider });
          setIsPresetPickerOpen(false);
        }}
      />
      {editor ? (
        <ProviderEditor
          provider={editor.provider}
          isNew={editor.index === null}
          existingAliases={config.providers.flatMap((provider, index) =>
            index === editor.index ? [] : provider.models.map((model) => model.alias),
          )}
          onChange={(provider) => setEditor((current) => (current ? { ...current, provider } : current))}
          onClose={() => setEditor(undefined)}
          onSave={() => {
            updateConfig((current) => ({
              ...current,
              providers:
                editor.index === null
                  ? [...current.providers, editor.provider]
                  : current.providers.map((provider, index) => (index === editor.index ? editor.provider : provider)),
            }));
            setEditor(undefined);
          }}
        />
      ) : null}
      <AlertDialog open={Boolean(providerToDelete)} onOpenChange={(open) => !open && setProviderToDelete(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除供应商</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除“{providerToDelete?.name}”吗？删除后需保存配置才会生效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!providerToDelete) return;
                updateConfig((current) => ({
                  ...current,
                  providers: current.providers.filter((_, index) => index !== providerToDelete.index),
                }));
                setProviderToDelete(undefined);
              }}
            >
              删除供应商
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ProviderPresetPicker({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (provider: ModelProvider) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] max-w-3xl gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-4 py-4 sm:px-5">
          <DialogTitle>选择供应商</DialogTitle>
          <DialogDescription>选择预设后将填充接口和推荐模型，API Key 需要自行填写。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          {providerPresets.map((preset) => (
            <Button
              key={preset.value}
              variant="outline"
              className="h-auto flex-col items-start justify-start whitespace-normal rounded-xl bg-card p-4 text-left hover:border-primary/50 hover:bg-accent/50 dark:bg-card dark:hover:bg-accent/80"
              onClick={() => onSelect(createProviderFromPreset(preset.provider))}
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-white p-2 ring-1 ring-black/5">
                <img aria-hidden src={preset.logo} alt="" className="size-full object-contain" />
              </span>
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="font-medium text-foreground">{preset.label}</span>
                <span className="text-xs leading-5 text-muted-foreground">{preset.description}</span>
              </span>
            </Button>
          ))}
          <Button
            variant="outline"
            className="h-auto flex-col items-start justify-start whitespace-normal rounded-xl border-dashed bg-card p-4 text-left hover:border-primary/50 hover:bg-accent/50 dark:bg-card dark:hover:bg-accent/80"
            onClick={() => onSelect(createProvider())}
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Settings2Icon className="size-5 text-muted-foreground" />
            </span>
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="font-medium text-foreground">自定义配置</span>
              <span className="text-xs leading-5 text-muted-foreground">
                手动填写供应商名称、接口类型、地址和模型。
              </span>
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderEditor({
  provider,
  isNew,
  existingAliases,
  onChange,
  onClose,
  onSave,
}: {
  provider: ModelProvider;
  isNew: boolean;
  existingAliases: string[];
  onChange: (provider: ModelProvider) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedModelIds, setFetchedModelIds] = useState<string[]>([]);
  const [modelOptionsIndex, setModelOptionsIndex] = useState<number>();
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const aliasCounts = new Map<string, number>();
  for (const alias of [...existingAliases, ...provider.models.map((model) => model.alias)]) {
    const normalizedAlias = alias.trim();
    if (normalizedAlias) aliasCounts.set(normalizedAlias, (aliasCounts.get(normalizedAlias) ?? 0) + 1);
  }
  const duplicateAliases = new Set(
    provider.models
      .map((model) => model.alias.trim())
      .filter((alias) => Boolean(alias) && (aliasCounts.get(alias) ?? 0) > 1),
  );

  function updateModel(
    index: number,
    update: (model: ModelProvider["models"][number]) => ModelProvider["models"][number],
  ) {
    onChange({
      ...provider,
      models: provider.models.map((model, modelIndex) => (modelIndex === index ? update(model) : model)),
    });
  }

  async function fetchModels() {
    setIsFetchingModels(true);
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: provider.type, ...provider.options }),
      });
      if (!response.ok) throw new Error(await getResponseError(response, "获取模型列表失败"));
      const data = (await response.json()) as { models?: unknown };
      if (!Array.isArray(data.models)) throw new Error("供应商返回的模型列表格式不正确");

      const modelIds = [
        ...new Set(data.models.filter((model): model is string => typeof model === "string" && Boolean(model))),
      ];
      setFetchedModelIds(modelIds);
      toast.success(`已获取 ${modelIds.length} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "获取模型列表失败");
    } finally {
      setIsFetchingModels(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={dialogContentRef}
        showCloseButton={false}
        className="flex max-h-[calc(100svh-2rem)] max-w-3xl flex-col gap-0 overflow-visible p-0 sm:max-w-3xl"
      >
        <DialogHeader className="border-b px-4 py-4 sm:px-5">
          <DialogTitle>{isNew ? "添加供应商" : "编辑供应商"}</DialogTitle>
          <DialogDescription>模型别名会用于模型分工和时段覆盖。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 sm:p-5">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="provider-name">供应商名称</FieldLabel>
              <Input
                id="provider-name"
                value={provider.name}
                onChange={(event) => onChange({ ...provider, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-type">接口类型</FieldLabel>
              <Select
                value={provider.type}
                onValueChange={(value) => onChange({ ...provider, type: value as ProviderType })}
              >
                <SelectTrigger id="provider-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {providerTypes.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>
                        <EndpointTypeIcon type={value} />
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="provider-base-url">API 基础 URL</FieldLabel>
              <Input
                id="provider-base-url"
                value={provider.options.base_url}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  onChange({ ...provider, options: { ...provider.options, base_url: event.target.value } })
                }
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="provider-api-key">API Key</FieldLabel>
              <Input
                id="provider-api-key"
                type="text"
                name="api-key"
                autoComplete="off"
                className="[-webkit-text-security:disc]"
                value={provider.options.api_key}
                onChange={(event) =>
                  onChange({ ...provider, options: { ...provider.options, api_key: event.target.value } })
                }
              />
            </Field>
          </FieldGroup>

          <section className="flex flex-col gap-4 border-t pt-5" aria-labelledby="provider-models-title">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 id="provider-models-title" className="text-sm font-medium">
                  模型列表
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">获取的模型仅作为模型 ID 的自动补全候选项。</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void fetchModels()} disabled={isFetchingModels}>
                  {isFetchingModels ? (
                    <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <RefreshCwIcon data-icon="inline-start" />
                  )}
                  获取模型
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onChange({ ...provider, models: [...provider.models, { id: "", alias: "" }] })}
                >
                  <PlusIcon data-icon="inline-start" />
                  添加模型
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              {provider.models.map((model, index) => (
                <div key={index} className="contents">
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium">模型 ID</span>
                    <ModelIdCombobox
                      value={model.id}
                      modelIds={[
                        ...new Set([
                          ...fetchedModelIds,
                          ...provider.models.map((current) => current.id).filter(Boolean),
                        ]),
                      ]}
                      portalContainer={dialogContentRef}
                      onChange={(value) => updateModel(index, (current) => ({ ...current, id: value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium">模型别名</span>
                    <Input
                      aria-invalid={duplicateAliases.has(model.alias.trim())}
                      value={model.alias}
                      onChange={(event) => updateModel(index, (current) => ({ ...current, alias: event.target.value }))}
                    />
                    {duplicateAliases.has(model.alias.trim()) ? (
                      <span className="text-xs text-destructive">模型别名“{model.alias.trim()}”已被使用</span>
                    ) : null}
                  </label>
                  <div className="flex items-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`配置模型参数 ${model.alias || model.id || index + 1}`}
                      onClick={() => setModelOptionsIndex(index)}
                    >
                      <Settings2Icon data-icon="inline-start" />
                      参数{getModelOptionCount(model.options) ? ` · ${getModelOptionCount(model.options)}` : ""}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除模型 ${model.alias || model.id || index + 1}`}
                      disabled={provider.models.length === 1}
                      onClick={() =>
                        onChange({
                          ...provider,
                          models: provider.models.filter((_, modelIndex) => modelIndex !== index),
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-3 px-4 py-4 sm:px-5">
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button onClick={onSave} disabled={duplicateAliases.size > 0}>
              完成编辑
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
      {modelOptionsIndex !== undefined && provider.models[modelOptionsIndex] ? (
        <ModelOptionsEditor
          key={modelOptionsIndex}
          model={provider.models[modelOptionsIndex]}
          providerType={provider.type}
          onClose={() => setModelOptionsIndex(undefined)}
          onSave={(options) => {
            updateModel(modelOptionsIndex, (model) => {
              const updated = { ...model };
              if (options) updated.options = options;
              else delete updated.options;
              return updated;
            });
            setModelOptionsIndex(undefined);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function ModelOptionsEditor({
  model,
  providerType,
  onClose,
  onSave,
}: {
  model: ModelProvider["models"][number];
  providerType: ProviderType;
  onClose: () => void;
  onSave: (options: ModelOptions | undefined) => void;
}) {
  const fieldId = useId();
  const [numberInputs, setNumberInputs] = useState<Record<ModelNumberOptionKey, string>>(
    () =>
      Object.fromEntries(modelNumberFields.map(({ key }) => [key, model.options?.[key]?.toString() ?? ""])) as Record<
        ModelNumberOptionKey,
        string
      >,
  );
  const [reasoning, setReasoning] = useState<ReasoningLevel | "unset">(model.options?.reasoning ?? "unset");
  const [stopSequences, setStopSequences] = useState(model.options?.stop_sequences?.join("\n") ?? "");
  const [providerOptionsInput, setProviderOptionsInput] = useState(() =>
    model.options?.provider_options ? JSON.stringify(model.options.provider_options, null, 2) : "",
  );

  const numberErrors = new Map(
    modelNumberFields.map((field) => [field.key, getOptionalNumberError(numberInputs[field.key], field.validate)]),
  );
  const providerOptionsResult = parseProviderOptions(providerOptionsInput);
  const hasErrors = [...numberErrors.values()].some(Boolean) || Boolean(providerOptionsResult.error);
  const providerLabel = providerTypes.find(({ value }) => value === providerType)?.label ?? providerType;

  function resetOptions() {
    setNumberInputs(
      Object.fromEntries(modelNumberFields.map(({ key }) => [key, ""])) as Record<ModelNumberOptionKey, string>,
    );
    setReasoning("unset");
    setStopSequences("");
    setProviderOptionsInput("");
  }

  function submitOptions() {
    if (hasErrors) return;

    const options: ModelOptions = {};
    for (const { key } of modelNumberFields) {
      const value = numberInputs[key].trim();
      if (value) options[key] = Number(value);
    }

    if (reasoning !== "unset") options.reasoning = reasoning;
    const sequences = stopSequences
      .split(/\r?\n/)
      .map((sequence) => sequence.trim())
      .filter(Boolean);
    if (sequences.length) options.stop_sequences = sequences;
    if (providerOptionsResult.value) options.provider_options = providerOptionsResult.value;

    onSave(Object.keys(options).length ? options : undefined);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100svh-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="border-b px-4 py-4 sm:px-5">
          <DialogTitle>模型参数</DialogTitle>
          <DialogDescription>
            为 {model.alias || model.id || "当前模型"} 设置默认生成参数，调用时显式传入的参数优先。
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-4 sm:p-5">
          <section className="flex flex-col gap-4" aria-labelledby={`${fieldId}-generation-title`}>
            <div className="flex flex-col gap-1">
              <h3 id={`${fieldId}-generation-title`} className="text-sm font-medium">
                通用生成参数
              </h3>
              <p className="text-xs text-muted-foreground">留空的字段不会写入配置，由模型或调用方决定。</p>
            </div>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              {modelNumberFields.map((field) => {
                const id = `${fieldId}-${field.key}`;
                const error = numberErrors.get(field.key);
                return (
                  <Field key={field.key} data-invalid={Boolean(error)}>
                    <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                    <Input
                      id={id}
                      type="number"
                      step={field.step ?? "any"}
                      aria-invalid={Boolean(error)}
                      value={numberInputs[field.key]}
                      placeholder="未设置"
                      onChange={(event) =>
                        setNumberInputs((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                    />
                    {error ? (
                      <FieldError>{error}</FieldError>
                    ) : (
                      <FieldDescription>{field.description}</FieldDescription>
                    )}
                  </Field>
                );
              })}
              <Field>
                <FieldLabel htmlFor={`${fieldId}-reasoning`}>推理强度</FieldLabel>
                <Select value={reasoning} onValueChange={(value) => setReasoning(value as ReasoningLevel | "unset")}>
                  <SelectTrigger id={`${fieldId}-reasoning`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="unset">未设置</SelectItem>
                      {reasoningLevels.map(({ value, label }) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>统一的推理强度，实际支持程度由模型决定。</FieldDescription>
              </Field>
            </FieldGroup>
          </section>

          <section className="flex flex-col gap-4" aria-labelledby={`${fieldId}-advanced-title`}>
            <div className="flex flex-col gap-1">
              <h3 id={`${fieldId}-advanced-title`} className="text-sm font-medium">
                高级参数
              </h3>
              <p className="text-xs text-muted-foreground">停止序列和 {providerLabel} 专属请求选项。</p>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${fieldId}-stop-sequences`}>停止序列</FieldLabel>
                <Textarea
                  id={`${fieldId}-stop-sequences`}
                  rows={4}
                  value={stopSequences}
                  placeholder={"每行一个停止序列\n例如：<END>"}
                  onChange={(event) => setStopSequences(event.target.value)}
                />
                <FieldDescription>每行填写一个值，空行会被忽略。</FieldDescription>
              </Field>
              <Field data-invalid={Boolean(providerOptionsResult.error)}>
                <FieldLabel htmlFor={`${fieldId}-provider-options`}>供应商专属选项</FieldLabel>
                <Textarea
                  id={`${fieldId}-provider-options`}
                  rows={7}
                  spellCheck={false}
                  aria-invalid={Boolean(providerOptionsResult.error)}
                  className="font-mono text-xs"
                  value={providerOptionsInput}
                  placeholder={'{\n  "reasoningEffort": "high"\n}'}
                  onChange={(event) => setProviderOptionsInput(event.target.value)}
                />
                {providerOptionsResult.error ? (
                  <FieldError>{providerOptionsResult.error}</FieldError>
                ) : (
                  <FieldDescription>填写 JSON 对象，字段名保持供应商原始格式。</FieldDescription>
                )}
              </Field>
            </FieldGroup>
          </section>
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-3 px-4 py-4 sm:px-5">
          <Button variant="ghost" className="sm:mr-auto" onClick={resetOptions}>
            清空全部
          </Button>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submitOptions} disabled={hasErrors}>
            应用参数
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelIdCombobox({
  value,
  modelIds,
  portalContainer,
  onChange,
}: {
  value: string;
  modelIds: string[];
  portalContainer: React.RefObject<HTMLElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <Combobox
      items={modelIds}
      value={modelIds.includes(value) ? value : null}
      inputValue={value}
      onValueChange={(nextValue) => onChange(nextValue ?? "")}
      onInputValueChange={(nextValue, { reason }) => {
        if (reason !== "item-press") onChange(nextValue);
      }}
    >
      <ComboboxInput aria-label="模型 ID" placeholder="输入或选择模型 ID" className="w-full" />
      <ComboboxContent container={portalContainer}>
        <ComboboxEmpty>未找到匹配的模型</ComboboxEmpty>
        <ComboboxList>
          {(modelId: string) => (
            <ComboboxItem key={modelId} value={modelId}>
              {modelId}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ProviderTypeBadge({ type }: { type: ProviderType }) {
  const providerType = providerTypes.find((item) => item.value === type) ?? providerTypes[0]!;

  return (
    <Badge variant="secondary">
      <EndpointTypeIcon type={type} />
      {providerType.label}
    </Badge>
  );
}

function EndpointTypeIcon({ type }: { type: ProviderType }) {
  if (type === "openai-responses" || type === "openai-compatible") {
    return (
      <span
        data-icon="inline-start"
        aria-hidden
        className="size-3 bg-current"
        style={{
          mask: `url(${openaiIcon}) center / contain no-repeat`,
          WebkitMask: `url(${openaiIcon}) center / contain no-repeat`,
        }}
      />
    );
  }

  return (
    <img
      data-icon="inline-start"
      aria-hidden
      src={providerIconPaths[type]}
      alt=""
      className="pointer-events-none size-3 object-contain"
    />
  );
}

function ModelAliasCombobox({
  value,
  aliases,
  emptyLabel = "请选择模型",
  onChange,
}: {
  value: string;
  aliases: string[];
  emptyLabel?: string;
  onChange: (value: string) => void;
}) {
  const hasUnknownValue = Boolean(value) && !aliases.includes(value);
  const items = hasUnknownValue ? [value, ...aliases] : aliases;

  return (
    <Combobox items={items} value={value || null} onValueChange={(nextValue) => onChange(nextValue ?? "")}>
      <ComboboxInput aria-label={emptyLabel} placeholder={emptyLabel} className="w-full" showClear={Boolean(value)} />
      <ComboboxContent>
        <ComboboxEmpty>未找到匹配的模型</ComboboxEmpty>
        <ComboboxList>
          {(alias: string) => (
            <ComboboxItem key={alias} value={alias}>
              {hasUnknownValue && alias === value ? `${alias}（未配置）` : alias}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
