import { useEffect, useRef, useState } from "react";
import anthropicIcon from "@/assets/provider-icons/anthropic.png";
import deepseekIcon from "@/assets/provider-icons/deepseek.png";
import openaiIcon from "@/assets/provider-icons/openai.png";
import {
  BrainCircuitIcon,
  Clock3Icon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ModelRole =
  | "plan"
  | "reply"
  | "main"
  | "task_explore"
  | "task_general"
  | "multimodal_image"
  | "multimodal_video"
  | "multimodal_audio";

type ProviderType = "anthropic" | "openai-responses" | "openai-compatible" | "deepseek";

type ModelProvider = {
  name: string;
  type: ProviderType;
  options: { base_url: string; api_key: string };
  models: Array<{ id: string; alias: string }>;
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
  { key: "plan", label: "规划", description: "拆解目标、规划执行步骤" },
  { key: "reply", label: "执行", description: "处理工具调用与任务执行" },
  { key: "main", label: "主代理", description: "单代理模式下的主模型" },
  { key: "task_explore", label: "探索子代理", description: "检索与快速代码探索" },
  { key: "task_general", label: "通用子代理", description: "处理多步骤通用任务" },
  { key: "multimodal_image", label: "图像理解", description: "分析图片与视觉内容" },
  { key: "multimodal_video", label: "视频理解", description: "分析视频内容" },
  { key: "multimodal_audio", label: "音频处理", description: "处理音频内容" },
];

const providerTypes: Array<{ value: ProviderType; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
  { value: "deepseek", label: "DeepSeek" },
];

const providerIconPaths: Record<ProviderType, string> = {
  anthropic: anthropicIcon,
  "openai-responses": openaiIcon,
  "openai-compatible": openaiIcon,
  deepseek: deepseekIcon,
};

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

function createProvider(): ModelProvider {
  return {
    name: "新供应商",
    type: "openai-compatible",
    options: { base_url: "", api_key: "" },
    models: [{ id: "", alias: "" }],
  };
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
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editor, setEditor] = useState<{ index: number | null; provider: ModelProvider }>();
  const [providerToDelete, setProviderToDelete] = useState<{ index: number; name: string }>();

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        if (!response.ok) throw new Error(await getResponseError(response, "无法加载配置"));
        setConfig((await response.json()) as BotConfig);
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
    setIsSaving(true);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error(await getResponseError(response, "保存配置失败"));
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
        <Button onClick={saveConfig} disabled={isSaving}>
          {isSaving ? (
            <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
          ) : (
            <SaveIcon data-icon="inline-start" />
          )}
          保存配置
        </Button>
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
          <Button variant="outline" onClick={() => setEditor({ index: null, provider: createProvider() })}>
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
              <CardFooter className="justify-end gap-2">
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
        className="max-h-[calc(100svh-2rem)] max-w-3xl gap-0 overflow-visible p-0 sm:max-w-3xl"
      >
        <DialogHeader className="border-b px-4 py-4 sm:px-5">
          <DialogTitle>{isNew ? "添加供应商" : "编辑供应商"}</DialogTitle>
          <DialogDescription>模型别名会用于模型分工和时段覆盖。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm font-medium">
              供应商名称
              <Input value={provider.name} onChange={(event) => onChange({ ...provider, name: event.target.value })} />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium">
              接口类型
              <Select
                value={provider.type}
                onValueChange={(value) => onChange({ ...provider, type: value as ProviderType })}
              >
                <SelectTrigger className="w-full">
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
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium sm:col-span-2">
              API 基础 URL
              <Input
                value={provider.options.base_url}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  onChange({ ...provider, options: { ...provider.options, base_url: event.target.value } })
                }
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium sm:col-span-2">
              API Key
              <Input
                type="text"
                name="api-key"
                autoComplete="off"
                className="[-webkit-text-security:disc]"
                value={provider.options.api_key}
                onChange={(event) =>
                  onChange({ ...provider, options: { ...provider.options, api_key: event.target.value } })
                }
              />
            </label>
          </div>

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
                  <div className="flex items-end">
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
