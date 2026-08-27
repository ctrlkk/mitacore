import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { XIcon } from "lucide-react";

type QQBotStatus = "idle" | "waiting_qr" | "connecting" | "ready" | "failed";

type QQBotConfig = {
  enabled: boolean;
  app_id?: string;
  app_secret?: string;
  admins: string[];
};

type BotConfig = Record<string, unknown> & {
  qqbot: QQBotConfig;
};

type RuntimeSnapshot = {
  qqbot: { status: QQBotStatus; qrcode_content?: string; error?: string };
};

const emptyQQBotConfig: QQBotConfig = { enabled: false, admins: [] };

const statusLabels: Record<QQBotStatus, string> = {
  idle: "等待启动",
  waiting_qr: "等待扫码",
  connecting: "正在连接",
  ready: "已连接",
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

export function QQBotChannelPage() {
  const [config, setConfig] = useState<BotConfig>();
  const [runtime, setRuntime] = useState<RuntimeSnapshot>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isManualConfigOpen, setIsManualConfigOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载 QQ Bot 配置"));
        if (!data || typeof data !== "object") throw new Error("QQ Bot 配置格式不正确");
        const nextConfig = data as Partial<BotConfig>;
        const qqbot = { ...emptyQQBotConfig, ...nextConfig.qqbot };
        setConfig({ ...nextConfig, qqbot } as BotConfig);
        setIsManualConfigOpen(Boolean(qqbot.app_id || qqbot.app_secret));
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "无法加载 QQ Bot 配置");
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
        if (snapshot.qqbot) setRuntime(snapshot as RuntimeSnapshot);
      } catch {
        // 忽略格式不完整的运行状态事件，等待下一次完整快照。
      }
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    if (runtime?.qqbot.status !== "ready") return;

    const controller = new AbortController();
    async function refreshCredentials() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok || !data || typeof data !== "object") return;
        const nextConfig = data as Partial<BotConfig>;
        setConfig((current) =>
          current
            ? ({ ...current, ...nextConfig, qqbot: { ...emptyQQBotConfig, ...nextConfig.qqbot } } as BotConfig)
            : current,
        );
      } catch {
        // 授权成功后的凭证刷新失败不影响已建立的渠道连接。
      }
    }

    void refreshCredentials();
    return () => controller.abort();
  }, [runtime?.qqbot.status]);

  function updateQQBot(update: (current: QQBotConfig) => QQBotConfig) {
    setConfig((current) => (current ? { ...current, qqbot: update(current.qqbot) } : current));
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
      if (!response.ok) throw new Error(getErrorMessage(data, "保存 QQ Bot 配置失败"));

      if (!restart) {
        toast.success("QQ Bot 配置已保存，重启后生效");
        return;
      }

      const restartResponse = await fetch("/api/runtime/restart", { method: "POST" });
      const restartData = await restartResponse.json().catch(() => undefined);
      if (!restartResponse.ok) throw new Error(getErrorMessage(restartData, "重启服务失败"));
      toast.success("配置已保存，服务正在重启");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 QQ Bot 配置失败");
    } finally {
      setIsSaving(false);
    }
  }

  const qqbot = config?.qqbot;
  const isEnabled = Boolean(qqbot?.enabled);
  const status = runtime?.qqbot.status ?? "idle";

  return (
    <section className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">QQ Bot</h1>
          <p className="text-sm text-muted-foreground">通过 QQ 官方机器人 API 接收群聊和私聊消息。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void saveConfig()} disabled={!config || isSaving}>
            保存配置
          </Button>
          <Button onClick={() => void saveConfig(true)} disabled={!config || isSaving}>
            保存并重启
          </Button>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="qqbot-channel-title">
        <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="qqbot-channel-title" className="font-semibold">
                QQ 官方机器人
              </h2>
              <StatusBadge status={status} enabled={isEnabled} />
            </div>
            <p className="text-sm text-muted-foreground">
              {qqbot?.app_id ? `AppID ${qqbot.app_id}` : "未配置授权凭证"}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="启用 QQ Bot 渠道"
            aria-checked={isEnabled}
            disabled={!qqbot}
            className="group flex h-8 items-center gap-2 px-1 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => updateQQBot((current) => ({ ...current, enabled: !current.enabled }))}
          >
            <span>{isEnabled ? "已启用" : "未启用"}</span>
            <span className="flex h-5 w-9 items-center rounded-full bg-muted p-0.5 transition-colors group-aria-checked:bg-primary">
              <span className="size-4 rounded-full bg-background shadow-sm transition-transform group-aria-checked:translate-x-4" />
            </span>
          </button>
        </div>

        {isLoading ? (
          <div className="px-4 py-12 text-sm text-muted-foreground sm:px-5">正在加载 QQ Bot 配置</div>
        ) : !qqbot ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5">
            配置加载失败，请刷新后重试。
          </div>
        ) : (
          <div className="grid gap-5 p-4 sm:p-5">
            <AuthorizationPanel enabled={isEnabled} runtime={runtime?.qqbot} />

            <details
              className="rounded-lg border"
              open={isManualConfigOpen}
              onToggle={(event) => setIsManualConfigOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">手动填写凭证</summary>
              <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm font-medium">
                  AppID
                  <Input
                    className="text-sm"
                    placeholder="输入 QQ Bot AppID"
                    value={qqbot.app_id ?? ""}
                    onChange={(event) => updateQQBot((current) => ({ ...current, app_id: event.target.value }))}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  AppSecret
                  <Input
                    className="text-sm"
                    type="password"
                    autoComplete="off"
                    placeholder="输入 QQ Bot AppSecret"
                    value={qqbot.app_secret ?? ""}
                    onChange={(event) => updateQQBot((current) => ({ ...current, app_secret: event.target.value }))}
                  />
                </label>
              </div>
            </details>

            <section className="flex flex-col gap-2" aria-labelledby="qqbot-admins-title">
              <div className="flex flex-col gap-1">
                <h3 id="qqbot-admins-title" className="text-sm font-medium">
                  管理员 OpenID
                </h3>
                <p className="text-xs text-muted-foreground">只有列表中的用户可以使用管理指令。</p>
              </div>
              <TagInput
                value={qqbot.admins}
                placeholder="输入 OpenID 后按回车"
                onChange={(update) => updateQQBot((current) => ({ ...current, admins: update(current.admins) }))}
              />
            </section>
          </div>
        )}
      </section>
    </section>
  );
}

function AuthorizationPanel({ enabled, runtime }: { enabled: boolean; runtime: RuntimeSnapshot["qqbot"] | undefined }) {
  const status = runtime?.status ?? "idle";

  if (!enabled && status === "idle") {
    return (
      <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
        启用渠道并保存重启后，可在此处使用 QQ 扫码授权。
      </p>
    );
  }

  if (status === "waiting_qr" && runtime?.qrcode_content) {
    return (
      <section
        className="grid gap-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        aria-labelledby="qqbot-authorization-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="qqbot-authorization-title" className="text-sm font-medium">
            使用 QQ 扫码授权
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">扫码成功后，凭证会自动保存到本地配置。</p>
          <button
            type="button"
            className="w-fit text-xs text-emerald-700 hover:underline dark:text-emerald-300"
            onClick={() => window.open(runtime.qrcode_content, "_blank", "noopener")}
          >
            在新窗口打开授权页
          </button>
        </div>
        <div className="justify-self-center rounded-lg bg-white p-3">
          <QRCodeSVG value={runtime.qrcode_content} size={164} level="M" />
        </div>
      </section>
    );
  }

  if (status === "connecting") {
    return (
      <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
        授权成功，QQ Bot 正在连接。
      </p>
    );
  }

  if (status === "ready") {
    return (
      <p className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200">
        QQ Bot 已连接。
      </p>
    );
  }

  if (status === "failed") {
    return (
      <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
        {runtime?.error ?? "QQ Bot 连接失败"}
      </p>
    );
  }

  return <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">QQ Bot 正在等待启动。</p>;
}

function TagInput({
  value,
  placeholder,
  onChange,
}: {
  value: string[];
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
        aria-label="添加管理员 OpenID"
        className="h-6 min-w-32 flex-1 border-0 px-1 py-0 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
        placeholder={placeholder}
        value={input}
        onChange={(event) => {
          const tags = textToList(event.target.value);
          if (tags.length > 1 || /[,，]/.test(event.target.value)) addTags(event.target.value);
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

function StatusBadge({ status, enabled }: { status: QQBotStatus; enabled: boolean }) {
  const isInactive = status === "idle" && !enabled;
  const className =
    status === "ready"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "waiting_qr" || status === "connecting"
        ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : status === "failed"
          ? "border-transparent bg-destructive/15 text-destructive"
          : "border-transparent bg-muted text-muted-foreground";

  return (
    <Badge variant="outline" className={className}>
      {isInactive ? "未启用" : statusLabels[status]}
    </Badge>
  );
}
