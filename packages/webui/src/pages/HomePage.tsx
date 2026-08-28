import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ChannelStatus =
  | "idle"
  | "waiting_qr"
  | "scanned"
  | "waiting_verify_code"
  | "connecting"
  | "starting"
  | "ready"
  | "offline"
  | "external"
  | "failed";

type ChannelConfig = { enabled: boolean };

type BotConfig = {
  napcat: ChannelConfig & { qq_id?: string; ws_url?: string };
  weixin: ChannelConfig & { account_id?: string };
  qqbot: ChannelConfig & { app_id?: string };
};

type RuntimeSnapshot = {
  napcat: { status: ChannelStatus };
  weixin: { status: ChannelStatus };
  qqbot: { status: ChannelStatus };
};

const statusLabels: Record<ChannelStatus, string> = {
  idle: "等待启动",
  waiting_qr: "等待扫码",
  scanned: "等待确认",
  waiting_verify_code: "等待验证码",
  connecting: "正在连接",
  starting: "正在启动",
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

function getEndpoint(wsUrl: string) {
  try {
    const url = new URL(wsUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return wsUrl;
  }
}

function getStatus(config: ChannelConfig, runtimeStatus: ChannelStatus | undefined) {
  if (runtimeStatus && runtimeStatus !== "idle") return runtimeStatus;
  return config.enabled ? "idle" : undefined;
}

export function HomePage() {
  const [config, setConfig] = useState<BotConfig>();
  const [runtime, setRuntime] = useState<RuntimeSnapshot>();

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        const data = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载渠道配置"));
        if (!data || typeof data !== "object") throw new Error("渠道配置格式不正确");
        setConfig(data as BotConfig);
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "无法加载渠道配置");
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
        const snapshot = JSON.parse((event as MessageEvent<string>).data) as RuntimeSnapshot;
        setRuntime(snapshot);
      } catch {
        // 忽略格式不完整的运行状态事件，等待下一次完整快照。
      }
    });
    return () => source.close();
  }, []);

  const onebotStatus = config ? getStatus(config.napcat, runtime?.napcat.status) : undefined;
  const weixinStatus = config ? getStatus(config.weixin, runtime?.weixin.status) : undefined;
  const qqbotStatus = config ? getStatus(config.qqbot, runtime?.qqbot.status) : undefined;

  return (
    <section className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">渠道管理</h1>
        <p className="text-sm text-muted-foreground">查看消息渠道的运行状态，并进入对应渠道完成配置。</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <ChannelCard
          name="OneBot"
          description="通过内置 NapCat 或外部 OneBot 接收 QQ 消息。"
          summary={
            config?.napcat.qq_id
              ? `内置 NapCat · QQ ${config.napcat.qq_id}`
              : config?.napcat.ws_url
                ? `外部 OneBot · ${getEndpoint(config.napcat.ws_url)}`
                : "尚未配置接入信息"
          }
          status={onebotStatus}
          action={
            <Button asChild size="sm">
              <Link to="/channels/onebot">配置 OneBot</Link>
            </Button>
          }
        />
        <ChannelCard
          name="微信"
          description="通过微信 iLink Bot 接收私聊消息。"
          summary={config?.weixin.account_id ? "已保存 Bot 凭证" : "扫码授权或手动填写凭证"}
          status={weixinStatus}
          action={
            <Button asChild size="sm">
              <Link to="/channels/weixin">配置微信</Link>
            </Button>
          }
        />
        <ChannelCard
          name="QQ Bot"
          description="通过 QQ 官方机器人 API 接收群聊和私聊消息。"
          summary={config?.qqbot.app_id ? "已保存 AppID 凭证" : "扫码授权或手动填写凭证"}
          status={qqbotStatus}
          action={
            <Button asChild size="sm">
              <Link to="/channels/qqbot">配置 QQ Bot</Link>
            </Button>
          }
        />
      </div>
    </section>
  );
}

function ChannelCard({
  name,
  description,
  summary,
  status,
  action,
  actionLabel,
}: {
  name: string;
  description: string;
  summary: string;
  status: ChannelStatus | undefined;
  action?: React.ReactNode;
  actionLabel?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4" aria-label={`${name}渠道`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">{name}</h2>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <StatusBadge status={status} />
      </div>
      <p className="truncate rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground" title={summary}>
        {summary}
      </p>
      <div className="flex min-h-7 items-center justify-end">
        {action ?? <span className="text-xs text-muted-foreground">{actionLabel}</span>}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: ChannelStatus | undefined }) {
  const className = !status
    ? "border-transparent bg-muted text-muted-foreground"
    : status === "ready" || status === "external"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "starting" ||
          status === "connecting" ||
          status === "waiting_qr" ||
          status === "scanned" ||
          status === "waiting_verify_code"
        ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : status === "offline" || status === "failed"
          ? "border-transparent bg-destructive/15 text-destructive"
          : "border-transparent bg-muted text-muted-foreground";

  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {status ? statusLabels[status] : "未启用"}
    </span>
  );
}
