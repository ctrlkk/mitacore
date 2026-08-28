import { useEffect, useState } from "react";
import { CircleAlertIcon, ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon, SaveIcon, XIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Scope = {
  mode: "whitelist" | "blacklist";
  ids: string[];
};

type OneBotConfig = {
  enabled: boolean;
  ws_url?: string;
  token?: string;
  qq_id?: string;
  wake_keywords: string[];
  groups: Scope;
  private_chats: Scope;
  group_members: Scope;
  admins: string[];
};

type BotConfig = Record<string, unknown> & {
  napcat: OneBotConfig;
};

type NapCatStatus = "idle" | "starting" | "waiting_qr" | "connecting" | "ready" | "offline" | "external" | "failed";

type RuntimeSnapshot = {
  napcat: {
    status: NapCatStatus;
    qrcode_content?: string;
    embed_url?: string;
    login_error?: string;
    error?: string;
  };
};

type ConnectionMode = "builtin" | "external";

const emptyScope: Scope = { mode: "blacklist", ids: [] };

const emptyOneBotConfig: OneBotConfig = {
  enabled: false,
  wake_keywords: [],
  groups: emptyScope,
  private_chats: emptyScope,
  group_members: emptyScope,
  admins: [],
};

const statusLabels: Record<NapCatStatus, string> = {
  idle: "等待启动",
  starting: "正在启动",
  waiting_qr: "等待扫码",
  connecting: "正在连接",
  ready: "已连接",
  offline: "QQ 已下线",
  external: "外部连接",
  failed: "连接失败",
};

function getErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = data.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") {
    return fallback;
  }
  return error.message;
}

function textToList(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function getConnectionMode(config: OneBotConfig): ConnectionMode {
  if (config.qq_id) return "builtin";
  return config.ws_url || config.token ? "external" : "builtin";
}

function getEndpoint(wsUrl: string | undefined) {
  if (!wsUrl) return "尚未配置 WebSocket 地址";
  try {
    const url = new URL(wsUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return wsUrl;
  }
}

export function OneBotChannelPage() {
  const [config, setConfig] = useState<BotConfig>();
  const [runtime, setRuntime] = useState<RuntimeSnapshot>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExternalSettingsOpen, setIsExternalSettingsOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载渠道配置"));
        if (!data || typeof data !== "object") throw new Error("渠道配置格式不正确");
        const nextConfig = data as Partial<BotConfig>;
        const napcat = { ...emptyOneBotConfig, ...nextConfig.napcat };
        setConfig({ ...nextConfig, napcat } as BotConfig);
        setIsExternalSettingsOpen(Boolean(napcat.ws_url || napcat.token));
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "无法加载渠道配置");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadConfig();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/runtime/events");
    source.addEventListener("runtime", (event) => {
      try {
        const snapshot = JSON.parse((event as MessageEvent<string>).data) as Partial<RuntimeSnapshot>;
        if (snapshot.napcat) setRuntime(snapshot as RuntimeSnapshot);
      } catch {
        // 忽略格式不完整的运行状态事件，等待下一次完整快照。
      }
    });
    return () => source.close();
  }, []);

  function updateOneBot(update: (current: OneBotConfig) => OneBotConfig) {
    setConfig((current) => (current ? { ...current, napcat: update(current.napcat) } : current));
  }

  async function saveConfig(restart = false) {
    if (!config || isSaving) return;

    setIsSaving(true);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(data, "保存渠道配置失败"));

      if (!restart) {
        toast.success("OneBot 配置已保存，重启后生效");
        return;
      }

      const restartResponse = await fetch("/api/runtime/restart", { method: "POST" });
      const restartData = await restartResponse.json().catch(() => undefined);
      if (!restartResponse.ok) throw new Error(getErrorMessage(restartData, "重启服务失败"));
      toast.success("配置已保存，服务正在重启");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存渠道配置失败");
    } finally {
      setIsSaving(false);
    }
  }

  const onebot = config?.napcat;
  const mode = onebot ? getConnectionMode(onebot) : "builtin";
  const isEnabled = Boolean(onebot?.enabled);
  const status = runtime?.napcat.status ?? "idle";

  return (
    <section className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">渠道管理</h1>
          <p className="text-sm text-muted-foreground">配置 OneBot 消息入口与访问范围。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void saveConfig()} disabled={!config || isSaving}>
            <SaveIcon data-icon="inline-start" />
            保存配置
          </Button>
          <Button onClick={() => void saveConfig(true)} disabled={!config || isSaving}>
            {isSaving ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            保存并重启
          </Button>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="onebot-title">
        <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="onebot-title" className="font-semibold">
                OneBot
              </h2>
              <StatusBadge status={status} enabled={isEnabled} />
            </div>
            <p className="text-sm text-muted-foreground">
              {mode === "builtin" ? "内置 NapCat" : `外部 WebSocket · ${getEndpoint(onebot?.ws_url)}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {runtime?.napcat.embed_url ? (
              <Button asChild variant="outline" size="sm">
                <a href={runtime.napcat.embed_url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon data-icon="inline-start" />
                  猫猫后台
                </a>
              </Button>
            ) : null}
            <button
              type="button"
              role="switch"
              aria-label="启用 OneBot 渠道"
              aria-checked={isEnabled}
              disabled={!onebot}
              className="group flex h-8 items-center gap-2 px-1 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => updateOneBot((current) => ({ ...current, enabled: !current.enabled }))}
            >
              <span>{isEnabled ? "已启用" : "未启用"}</span>
              <span className="flex h-5 w-9 items-center rounded-full bg-muted p-0.5 transition-colors group-aria-checked:bg-primary">
                <span className="size-4 rounded-full bg-background shadow-sm transition-transform group-aria-checked:translate-x-4" />
              </span>
            </button>
          </div>
        </div>

        {runtime?.napcat.error ? (
          <div className="flex gap-2 border-b bg-destructive/10 px-4 py-3 text-sm text-destructive sm:px-5">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <p>{runtime.napcat.error}</p>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 px-4 py-12 text-sm text-muted-foreground sm:px-5">
            <LoaderCircleIcon className="size-4 animate-spin" />
            正在加载 OneBot 配置
          </div>
        ) : !onebot ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5">
            配置加载失败，请刷新后重试。
          </div>
        ) : (
          <div className="flex flex-col gap-6 p-4 sm:p-5">
            <NapCatLoginPanel enabled={isEnabled} mode={mode} runtime={runtime?.napcat} />

            <section className="grid gap-3" aria-labelledby="connection-settings-title">
              <div className="flex flex-col gap-1">
                <h3 id="connection-settings-title" className="text-sm font-medium">
                  接入方式
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  填写 QQ 号时使用内置 NapCat；留空则连接下方配置的外部 OneBot。
                </p>
              </div>
              <label className="flex max-w-md flex-col gap-2 text-sm font-medium">
                机器人 QQ 号
                <Input
                  className="text-sm"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="填写机器人自身的 QQ 号"
                  value={onebot.qq_id ?? ""}
                  onChange={(event) =>
                    updateOneBot((current) => ({ ...current, qq_id: event.target.value.replaceAll(/\D/g, "") }))
                  }
                />
              </label>
              <details
                className="rounded-lg border"
                open={isExternalSettingsOpen}
                onToggle={(event) => setIsExternalSettingsOpen(event.currentTarget.open)}
              >
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">外部 OneBot 连接</summary>
                <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    WebSocket 地址
                    <Input
                      className="text-sm"
                      type="url"
                      placeholder="ws://127.0.0.1:3001"
                      value={onebot.ws_url ?? ""}
                      onChange={(event) => updateOneBot((current) => ({ ...current, ws_url: event.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    访问令牌
                    <Input
                      className="text-sm"
                      type="password"
                      autoComplete="off"
                      placeholder="输入 OneBot access token"
                      value={onebot.token ?? ""}
                      onChange={(event) => updateOneBot((current) => ({ ...current, token: event.target.value }))}
                    />
                  </label>
                </div>
              </details>
            </section>

            <section className="grid gap-4 border-t pt-5" aria-labelledby="access-settings-title">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                <h3 id="access-settings-title" className="text-sm font-medium">
                  消息范围与权限
                </h3>
                <p className="text-xs text-muted-foreground">设置可触发机器人及使用管理指令的账号。</p>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-2 text-sm font-medium">
                  <span>群聊唤醒关键词</span>
                  <TagInput
                    ariaLabel="添加群聊唤醒关键词"
                    value={onebot.wake_keywords}
                    placeholder="输入关键词后按回车"
                    onChange={(update) =>
                      updateOneBot((current) => ({ ...current, wake_keywords: update(current.wake_keywords) }))
                    }
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-2 text-sm font-medium">
                  <span>管理员 QQ 号</span>
                  <TagInput
                    ariaLabel="管理员 QQ 号"
                    placeholder="输入 QQ 号后按回车"
                    value={onebot.admins}
                    onChange={(update) => updateOneBot((current) => ({ ...current, admins: update(current.admins) }))}
                  />
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-3">
                <ScopeEditor
                  label="群聊范围"
                  scope={onebot.groups}
                  onChange={(update) => updateOneBot((current) => ({ ...current, groups: update(current.groups) }))}
                />
                <ScopeEditor
                  label="私聊范围"
                  scope={onebot.private_chats}
                  onChange={(update) =>
                    updateOneBot((current) => ({ ...current, private_chats: update(current.private_chats) }))
                  }
                />
                <ScopeEditor
                  label="群成员范围"
                  scope={onebot.group_members}
                  onChange={(update) =>
                    updateOneBot((current) => ({ ...current, group_members: update(current.group_members) }))
                  }
                />
              </div>
            </section>
          </div>
        )}
      </section>
    </section>
  );
}

function StatusBadge({ status, enabled }: { status: NapCatStatus; enabled: boolean }) {
  const isInactive = status === "idle" && !enabled;
  const className =
    status === "ready" || status === "external"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "starting" || status === "waiting_qr" || status === "connecting"
        ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : status === "offline" || status === "failed"
          ? "border-transparent bg-destructive/15 text-destructive"
          : "border-transparent bg-muted text-muted-foreground";

  return (
    <Badge variant="outline" className={className}>
      {isInactive ? "未启用" : statusLabels[status]}
    </Badge>
  );
}

function NapCatLoginPanel({
  enabled,
  mode,
  runtime,
}: {
  enabled: boolean;
  mode: ConnectionMode;
  runtime: RuntimeSnapshot["napcat"] | undefined;
}) {
  if (mode !== "builtin") return null;

  const status = runtime?.status ?? "idle";
  if (!enabled && status === "idle") {
    return (
      <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
        启用渠道并保存重启后，可在此处使用 QQ 扫码登录。
      </p>
    );
  }

  if (status === "waiting_qr" && runtime?.qrcode_content) {
    return (
      <section
        className="grid gap-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        aria-labelledby="napcat-login-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="napcat-login-title" className="text-sm font-medium">
            使用 QQ 扫码登录
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">登录成功后，OneBot 会自动连接。</p>
          {runtime.login_error ? <p className="text-xs text-destructive">{runtime.login_error}</p> : null}
        </div>
        <div className="justify-self-center rounded-lg bg-white p-3">
          <QRCodeSVG value={runtime.qrcode_content} size={164} level="M" />
        </div>
      </section>
    );
  }

  if (status === "waiting_qr") {
    return (
      <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
        {runtime?.login_error ?? "正在获取 QQ 登录二维码。"}
      </p>
    );
  }

  if (status === "connecting") {
    return (
      <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
        已检测到 QQ 登录，OneBot 正在连接。
      </p>
    );
  }

  if (status === "ready") {
    return (
      <p className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200">
        QQ 已登录，OneBot 已连接。
      </p>
    );
  }

  if (status === "offline") {
    return (
      <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
        QQ 账号已下线，请在 QQ 中重新登录或重新扫码。
      </p>
    );
  }

  return null;
}

function TagInput({
  value,
  ariaLabel,
  placeholder,
  onChange,
}: {
  value: string[];
  ariaLabel: string;
  placeholder: string;
  onChange: (update: (value: string[]) => string[]) => void;
}) {
  const [input, setInput] = useState("");

  function addTags(rawValue: string) {
    const tags = textToList(rawValue);
    if (tags.length > 0) onChange((current) => [...new Set([...current, ...tags])]);
    setInput("");
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent p-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-5 items-center gap-1 rounded-md bg-secondary px-1.5 text-xs text-secondary-foreground"
        >
          {tag}
          <button
            type="button"
            aria-label={`删除 ${tag}`}
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange((current) => current.filter((value) => value !== tag))}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <Input
        aria-label={ariaLabel}
        className="h-6 min-w-32 flex-1 border-0 px-1 py-0 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
        placeholder={placeholder}
        value={input}
        onChange={(event) => {
          const segments = textToList(event.target.value);
          if (segments.length > 1 || /[,，]/.test(event.target.value)) addTags(event.target.value);
          else setInput(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            addTags(input);
          } else if (event.key === "Backspace" && !input && value.length > 0) {
            onChange((current) => current.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

function ScopeEditor({
  label,
  scope,
  onChange,
}: {
  label: string;
  scope: Scope;
  onChange: (update: (scope: Scope) => Scope) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        <div role="radiogroup" aria-label={`${label}模式`} className="flex rounded-lg bg-muted p-0.5">
          {(["whitelist", "blacklist"] as const).map((mode) => {
            const selected = scope.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground aria-checked:bg-card aria-checked:font-medium aria-checked:text-foreground aria-checked:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onChange((current) => ({ ...current, mode }))}
              >
                {mode === "whitelist" ? "白名单" : "黑名单"}
              </button>
            );
          })}
        </div>
      </div>
      <TagInput
        ariaLabel={`${label} ID 列表`}
        placeholder={`输入 ${label} ID 后按回车`}
        value={scope.ids}
        onChange={(update) => onChange((current) => ({ ...current, ids: update(current.ids) }))}
      />
    </section>
  );
}
