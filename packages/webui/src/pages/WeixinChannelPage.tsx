import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type WeixinStatus = "idle" | "waiting_qr" | "scanned" | "waiting_verify_code" | "ready" | "failed";

type WeixinConfig = {
  enabled: boolean;
  account_id?: string;
  token?: string;
};

type BotConfig = Record<string, unknown> & {
  weixin: WeixinConfig;
};

type RuntimeSnapshot = {
  weixin: { status: WeixinStatus; qrcode_content?: string; error?: string };
};

const emptyWeixinConfig: WeixinConfig = { enabled: false };

const statusLabels: Record<WeixinStatus, string> = {
  idle: "等待启动",
  waiting_qr: "等待扫码",
  scanned: "等待确认",
  waiting_verify_code: "等待验证码",
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

export function WeixinChannelPage() {
  const [config, setConfig] = useState<BotConfig>();
  const [runtime, setRuntime] = useState<RuntimeSnapshot>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [isManualConfigOpen, setIsManualConfigOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载微信配置"));
        if (!data || typeof data !== "object") throw new Error("微信配置格式不正确");
        const nextConfig = data as Partial<BotConfig>;
        const weixin = { ...emptyWeixinConfig, ...nextConfig.weixin };
        setConfig({ ...nextConfig, weixin } as BotConfig);
        setIsManualConfigOpen(Boolean(weixin.account_id || weixin.token));
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "无法加载微信配置");
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
        if (snapshot.weixin) setRuntime(snapshot as RuntimeSnapshot);
      } catch {
        // 忽略格式不完整的运行状态事件，等待下一次完整快照。
      }
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    if (runtime?.weixin.status !== "ready") return;

    const controller = new AbortController();
    async function refreshCredentials() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok || !data || typeof data !== "object") return;
        const nextConfig = data as Partial<BotConfig>;
        setConfig((current) =>
          current
            ? ({ ...current, ...nextConfig, weixin: { ...emptyWeixinConfig, ...nextConfig.weixin } } as BotConfig)
            : current,
        );
      } catch {
        // 授权成功后的凭证刷新失败不影响已建立的渠道连接。
      }
    }

    void refreshCredentials();
    return () => controller.abort();
  }, [runtime?.weixin.status]);

  function updateWeixin(update: (current: WeixinConfig) => WeixinConfig) {
    setConfig((current) => (current ? { ...current, weixin: update(current.weixin) } : current));
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
      if (!response.ok) throw new Error(getErrorMessage(data, "保存微信配置失败"));

      if (!restart) {
        toast.success("微信配置已保存，重启后生效");
        return;
      }

      const restartResponse = await fetch("/api/runtime/restart", { method: "POST" });
      const restartData = await restartResponse.json().catch(() => undefined);
      if (!restartResponse.ok) throw new Error(getErrorMessage(restartData, "重启服务失败"));
      toast.success("配置已保存，服务正在重启");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存微信配置失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function submitVerifyCode() {
    const code = verifyCode.trim();
    if (!code || isSubmittingCode) return;

    setIsSubmittingCode(true);
    try {
      const response = await fetch("/api/weixin/login/verify-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(data, "验证码提交失败"));
      setVerifyCode("");
      toast.success("验证码已提交");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "验证码提交失败");
    } finally {
      setIsSubmittingCode(false);
    }
  }

  const weixin = config?.weixin;
  const isEnabled = Boolean(weixin?.enabled);
  const status = runtime?.weixin.status ?? "idle";

  return (
    <section className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">微信</h1>
          <p className="text-sm text-muted-foreground">通过 iLink Bot 授权接收微信私聊消息。</p>
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

      <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="weixin-channel-title">
        <div className="flex flex-col gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="weixin-channel-title" className="font-semibold">
                微信渠道
              </h2>
              <StatusBadge status={status} enabled={isEnabled} />
            </div>
            <p className="text-sm text-muted-foreground">
              {weixin?.account_id ? `Bot 账号 ${weixin.account_id}` : "未配置授权凭证"}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="启用微信渠道"
            aria-checked={isEnabled}
            disabled={!weixin}
            className="group flex h-8 items-center gap-2 px-1 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => updateWeixin((current) => ({ ...current, enabled: !current.enabled }))}
          >
            <span>{isEnabled ? "已启用" : "未启用"}</span>
            <span className="flex h-5 w-9 items-center rounded-full bg-muted p-0.5 transition-colors group-aria-checked:bg-primary">
              <span className="size-4 rounded-full bg-background shadow-sm transition-transform group-aria-checked:translate-x-4" />
            </span>
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 px-4 py-12 text-sm text-muted-foreground sm:px-5">
            正在加载微信配置
          </div>
        ) : !weixin ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5">
            配置加载失败，请刷新后重试。
          </div>
        ) : (
          <div className="grid gap-5 p-4 sm:p-5">
            <AuthorizationPanel
              enabled={isEnabled}
              runtime={runtime?.weixin}
              verifyCode={verifyCode}
              isSubmittingCode={isSubmittingCode}
              onVerifyCodeChange={setVerifyCode}
              onSubmitCode={() => void submitVerifyCode()}
            />

            <details
              className="rounded-lg border"
              open={isManualConfigOpen}
              onToggle={(event) => setIsManualConfigOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">手动填写凭证</summary>
              <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Bot 账号 ID
                  <Input
                    className="text-sm"
                    placeholder="输入 Bot 账号 ID"
                    value={weixin.account_id ?? ""}
                    onChange={(event) => updateWeixin((current) => ({ ...current, account_id: event.target.value }))}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Bot Token
                  <Input
                    className="text-sm"
                    type="password"
                    autoComplete="off"
                    placeholder="输入 Bot Token"
                    value={weixin.token ?? ""}
                    onChange={(event) => updateWeixin((current) => ({ ...current, token: event.target.value }))}
                  />
                </label>
              </div>
            </details>
          </div>
        )}
      </section>
    </section>
  );
}

function AuthorizationPanel({
  enabled,
  runtime,
  verifyCode,
  isSubmittingCode,
  onVerifyCodeChange,
  onSubmitCode,
}: {
  enabled: boolean;
  runtime: RuntimeSnapshot["weixin"] | undefined;
  verifyCode: string;
  isSubmittingCode: boolean;
  onVerifyCodeChange: (value: string) => void;
  onSubmitCode: () => void;
}) {
  const status = runtime?.status ?? "idle";

  if (!enabled && status === "idle") {
    return (
      <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
        启用渠道并保存重启后，可在此处使用微信扫码授权。
      </p>
    );
  }

  if (status === "waiting_qr" && runtime?.qrcode_content) {
    return (
      <section
        className="grid gap-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        aria-labelledby="weixin-authorization-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="weixin-authorization-title" className="text-sm font-medium">
            使用微信扫码授权
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            扫描后请在手机上确认授权。二维码失效时，服务会自动生成新的二维码。
          </p>
          <button
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

  if (status === "scanned") {
    return (
      <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
        二维码已扫描，正在等待手机确认。
      </p>
    );
  }

  if (status === "waiting_verify_code") {
    return (
      <section className="grid gap-3 rounded-lg bg-amber-500/10 p-3" aria-labelledby="verify-code-title">
        <div className="flex flex-col gap-1">
          <h3 id="verify-code-title" className="text-sm font-medium">
            输入微信验证码
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">请输入微信客户端显示的数字验证码。</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            className="max-w-sm text-sm"
            inputMode="numeric"
            placeholder="输入验证码"
            value={verifyCode}
            onChange={(event) => onVerifyCodeChange(event.target.value.replaceAll(/\D/g, ""))}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmitCode();
            }}
          />
          <Button onClick={onSubmitCode} disabled={!verifyCode.trim() || isSubmittingCode}>
            提交验证码
          </Button>
        </div>
      </section>
    );
  }

  if (status === "ready") {
    return (
      <p className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200">
        微信渠道已连接。
      </p>
    );
  }

  if (status === "failed") {
    return (
      <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
        {runtime?.error ?? "微信渠道连接失败"}
      </p>
    );
  }

  return <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">微信渠道正在等待启动。</p>;
}

function StatusBadge({ status, enabled }: { status: WeixinStatus; enabled: boolean }) {
  const isInactive = status === "idle" && !enabled;
  const className =
    status === "ready"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "waiting_qr" || status === "scanned" || status === "waiting_verify_code"
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
