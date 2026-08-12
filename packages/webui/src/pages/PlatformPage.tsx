import { Input, QRCode, Select, Switch } from "antd";
import { useEffect, useState } from "react";
import { ScopeEditor } from "../components/ScopeEditor";
import { useChannels, type ChannelSnapshot } from "../hooks/useChannels";
import type { Config } from "../types";

type Props = {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  reloadConfig(): Promise<void>;
};

type ChannelName = "napcat" | "qqbot" | "weixin";

type ChannelTabProps = {
  active: boolean;
  description: string;
  enabled: boolean;
  eyebrow: string;
  id: ChannelName;
  name: string;
  status: string;
  onSelect(): void;
  onToggle(enabled: boolean): void;
};

function ChannelTab({ active, description, enabled, eyebrow, id, name, status, onSelect, onToggle }: ChannelTabProps) {
  const selectWithKeyboard = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-controls={`channel-panel-${id}`}
      aria-selected={active}
      className="channel-tab"
      data-active={active}
      onClick={onSelect}
      onKeyDown={selectWithKeyboard}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="mb-1 font-mono text-[9px] tracking-[0.1em] text-muted">{eyebrow}</p>
          <h3 className="text-sm">{name}</h3>
        </div>
        <span onClick={(event) => event.stopPropagation()}>
          <Switch checked={enabled} aria-label={`${enabled ? "停用" : "启用"}${name}`} onChange={onToggle} />
        </span>
      </div>
      <p className="text-xs leading-[1.5] text-muted">{description}</p>
      <div className="mt-auto flex items-center gap-2 text-[11px] text-[#486071]">
        <span className={`h-1.75 w-1.75 rounded-full ${enabled ? "bg-brand" : "bg-[#aeb8bf]"}`} />
        {enabled ? status : "已停用"}
      </div>
    </div>
  );
}

function getStatusLabel(channel: ChannelName, channels: ChannelSnapshot) {
  const status = channels[channel].status;
  if (status === "ready") return "运行中";
  if (status === "failed") return "连接异常";
  if (status === "waiting_qr") return "等待扫码";
  if (status === "connecting" || status === "starting") return "连接中";
  if (status === "external") return "外部连接";
  if (status === "scanned" || status === "waiting_verify_code") return "等待确认";
  return "等待重启生效";
}

export function PlatformPage({ config, setConfig, reloadConfig }: Props) {
  const channels = useChannels();
  const [activeChannel, setActiveChannel] = useState<ChannelName>("napcat");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (channels.weixin.status === "ready" || channels.qqbot.status === "ready") void reloadConfig();
  }, [channels.qqbot.status, channels.weixin.status, reloadConfig]);

  const updateNapcat = (patch: Partial<Config["napcat"]>) =>
    setConfig((value) => ({ ...value, napcat: { ...value.napcat, ...patch } }));
  const updateQQBot = (patch: Partial<Config["qqbot"]>) =>
    setConfig((value) => ({ ...value, qqbot: { ...value.qqbot, ...patch } }));
  const updateWeixin = (patch: Partial<Config["weixin"]>) =>
    setConfig((value) => ({ ...value, weixin: { ...value.weixin, ...patch } }));

  const submitVerifyCode = async () => {
    setSubmitting(true);
    setVerifyError("");
    try {
      const response = await fetch("/api/weixin/login/verify-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: verifyCode }),
      });
      const data = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "验证码提交失败");
      setVerifyCode("");
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "验证码提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1240px] px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5">
          <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">CHANNELS</p>
          <h2 className="text-lg tracking-[-0.02em]">消息渠道</h2>
          <p className="mt-1.25 text-xs leading-[1.5] text-muted">选择渠道查看详细配置；每个渠道可独立启用。</p>
        </div>

        <div role="tablist" aria-label="消息渠道" className="grid grid-cols-3 gap-3 max-[820px]:grid-cols-1">
          <ChannelTab
            active={activeChannel === "napcat"}
            description="使用普通 QQ 账号收发群聊与私聊消息。"
            enabled={config.napcat.enabled}
            eyebrow="PERSONAL QQ"
            id="napcat"
            name="NapCat"
            status={getStatusLabel("napcat", channels)}
            onSelect={() => setActiveChannel("napcat")}
            onToggle={(enabled) => updateNapcat({ enabled })}
          />
          <ChannelTab
            active={activeChannel === "qqbot"}
            description="官方 Bot API，推荐留空凭证后扫码授权。"
            enabled={config.qqbot.enabled}
            eyebrow="OFFICIAL BOT API"
            id="qqbot"
            name="QQ 官方机器人"
            status={getStatusLabel("qqbot", channels)}
            onSelect={() => setActiveChannel("qqbot")}
            onToggle={(enabled) => updateQQBot({ enabled })}
          />
          <ChannelTab
            active={activeChannel === "weixin"}
            description="iLink Bot 渠道，推荐留空凭证后扫码授权。"
            enabled={config.weixin.enabled}
            eyebrow="WEIXIN ILINK"
            id="weixin"
            name="微信"
            status={getStatusLabel("weixin", channels)}
            onSelect={() => setActiveChannel("weixin")}
            onToggle={(enabled) => updateWeixin({ enabled })}
          />
        </div>

        {activeChannel === "napcat" && (
          <section
            key="napcat"
            id="channel-panel-napcat"
            role="tabpanel"
            className="channel-tab-panel"
            aria-label="NapCat 详细配置"
          >
            <div className="flex items-start justify-between gap-5 max-[640px]:block">
              <div>
                <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-brand">NAPCAT SETTINGS</p>
                <h3 className="text-base">NapCat 详细配置</h3>
                <p className="mt-1.25 text-xs leading-[1.5] text-muted">账号、唤醒方式和访问范围只作用于 NapCat。</p>
              </div>
              <span className="mt-0.5 rounded-full bg-[#edf7f2] px-2.5 py-1 text-[11px] text-[#416050] max-[640px]:mt-3 max-[640px]:inline-block">
                {config.napcat.enabled ? getStatusLabel("napcat", channels) : "当前未启用"}
              </span>
            </div>

            {config.napcat.enabled && channels.napcat.status === "starting" && !channels.napcat.embed_url && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                NapCat 正在启动…
              </p>
            )}
            {config.napcat.enabled && channels.napcat.status === "starting" && channels.napcat.embed_url && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                NapCat WebUI 已启动，请在管理后台登录 QQ。
              </p>
            )}
            {config.napcat.enabled && channels.napcat.embed_url && (
              <div className="flex items-center justify-between gap-3 rounded-lg b-success bg-[#f5fbf8] p-3.5 text-xs">
                <strong>NapCat 管理面板</strong>
                <button
                  className="bg-transparent py-0.75 font-700 text-brand"
                  onClick={() => window.open(channels.napcat.embed_url, "_blank", "noopener")}
                >
                  打开管理后台
                </button>
              </div>
            )}
            {config.napcat.enabled && channels.napcat.status === "external" && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                外置 NapCat 不提供内嵌管理面板。
              </p>
            )}
            {config.napcat.enabled && channels.napcat.error && (
              <p className="rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
                {channels.napcat.error}
              </p>
            )}

            <div className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
              <div className="grid content-start gap-3.75 rounded-[10px] bg-[#f8fafb] p-4">
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  机器人 QQ 号
                  <Input
                    value={config.napcat.qq_id ?? ""}
                    inputMode="numeric"
                    onChange={(event) => updateNapcat({ qq_id: event.target.value })}
                    placeholder="请输入 QQ 号"
                  />
                </label>
                <p className="rounded-lg bg-[#fff8e8] px-3 py-2.5 text-xs leading-[1.5] text-[#765a24]">
                  给机器人 QQ 账号完成实名认证，可以大幅降低被强制下线的概率。
                </p>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  群聊唤醒关键词
                  <Select
                    mode="tags"
                    value={config.napcat.wake_keywords}
                    onChange={(wake_keywords) => updateNapcat({ wake_keywords })}
                    placeholder="输入关键词后按回车"
                    tokenSeparators={[]}
                  />
                  <span className="font-400 leading-[1.5] text-muted">消息包含任一关键词时，无需 @ 机器人。</span>
                </label>
                <details>
                  <summary className="cursor-pointer text-xs text-[#486071]">外部 NapCat 连接设置</summary>
                  <div className="mt-3 grid gap-3">
                    <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                      WebSocket 地址
                      <Input
                        value={config.napcat.ws_url ?? ""}
                        onChange={(event) => updateNapcat({ ws_url: event.target.value })}
                        placeholder="ws://localhost:3001"
                      />
                    </label>
                    <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                      Token
                      <Input.Password
                        value={config.napcat.token ?? ""}
                        onChange={(event) => updateNapcat({ token: event.target.value })}
                      />
                    </label>
                  </div>
                </details>
              </div>
              <div className="grid content-start gap-3">
                <div>
                  <p className="font-mono text-[10px] tracking-[0.1em] text-muted">ACCESS</p>
                  <h4 className="mt-1 text-sm">访问范围</h4>
                  <p className="mt-1 text-xs leading-[1.5] text-muted">控制哪些群聊、私聊和群成员可以触发机器人。</p>
                </div>
                <ScopeEditor
                  label="NapCat 群聊"
                  value={config.napcat.groups}
                  onChange={(groups) => updateNapcat({ groups })}
                  idLabel="QQ号"
                />
                <ScopeEditor
                  label="NapCat 私聊"
                  value={config.napcat.private_chats}
                  onChange={(private_chats) => updateNapcat({ private_chats })}
                  idLabel="QQ号"
                />
                <ScopeEditor
                  label="NapCat 群内成员"
                  value={config.napcat.group_members}
                  onChange={(group_members) => updateNapcat({ group_members })}
                  idLabel="QQ号"
                />
              </div>
            </div>
          </section>
        )}

        {activeChannel === "qqbot" && (
          <section
            key="qqbot"
            id="channel-panel-qqbot"
            role="tabpanel"
            className="channel-tab-panel"
            aria-label="QQ 官方机器人详细配置"
          >
            <div>
              <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-brand">OFFICIAL BOT SETTINGS</p>
              <h3 className="text-base">QQ 官方机器人详细配置</h3>
              <p className="mt-1.25 text-xs leading-[1.5] text-muted">
                推荐留空 AppID 和 AppSecret，通过 QQ 扫码完成授权。
              </p>
            </div>

            {config.qqbot.enabled && channels.qqbot.status === "waiting_qr" && channels.qqbot.qrcode_content && (
              <div className="grid justify-items-center gap-3 rounded-lg b-success bg-[#f5fbf8] p-4 text-center">
                <div>
                  <strong className="text-sm">使用 QQ 扫码授权机器人</strong>
                  <p className="mt-1.25 text-xs leading-[1.5] text-muted">授权成功后，凭证会自动保存到本地配置。</p>
                </div>
                <QRCode value={channels.qqbot.qrcode_content} size={176} />
                <button
                  className="bg-transparent text-xs font-700 text-brand"
                  onClick={() => window.open(channels.qqbot.qrcode_content, "_blank", "noopener")}
                >
                  无法扫码？打开授权页
                </button>
              </div>
            )}
            {config.qqbot.enabled && channels.qqbot.status === "connecting" && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                QQ 官方机器人正在连接…
              </p>
            )}
            {config.qqbot.enabled && channels.qqbot.status === "ready" && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                QQ 官方机器人已连接。
              </p>
            )}
            {config.qqbot.enabled && channels.qqbot.error && (
              <p className="rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
                {channels.qqbot.error}
              </p>
            )}

            <div className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
              <div className="rounded-[10px] b-success bg-[#f5fbf8] p-4 text-xs leading-[1.7] text-[#416050]">
                <div className="mb-2 flex items-center gap-2">
                  <strong className="text-sm text-[#294051]">扫码授权</strong>
                  <span className="rounded-full bg-[#dcefe8] px-2 py-0.5 text-[10px] font-700 text-brand">推荐</span>
                </div>
                <p>保持右侧两个凭证字段为空，启用渠道并保存配置，然后重启服务。</p>
                <p className="mt-2">重启后，本页面会显示 QQ 授权二维码；扫码成功后凭证将自动保存。</p>
              </div>
              <div className="grid content-start gap-3.75 rounded-[10px] bg-[#f8fafb] p-4">
                <div>
                  <strong className="text-sm text-[#294051]">手动配置</strong>
                  <span className="ml-2 text-[11px] font-400 text-muted">可选</span>
                </div>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  AppID
                  <Input
                    value={config.qqbot.app_id ?? ""}
                    onChange={(event) => updateQQBot({ app_id: event.target.value })}
                    placeholder="QQ 机器人的 AppID"
                  />
                </label>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  AppSecret
                  <Input.Password
                    value={config.qqbot.app_secret ?? ""}
                    onChange={(event) => updateQQBot({ app_secret: event.target.value })}
                    placeholder="QQ 机器人的 AppSecret"
                  />
                </label>
                <p className="text-[11px] leading-[1.5] text-muted">
                  如需手动配置，可从
                  <a
                    className="mx-1 font-700 text-brand hover:underline"
                    href="https://q.qq.com/qqbot/openclaw/index.html"
                    target="_blank"
                    rel="noreferrer"
                  >
                    QQ 开放平台
                  </a>
                  获取凭证。AppSecret 请勿截图或分享。
                </p>
              </div>
            </div>
          </section>
        )}

        {activeChannel === "weixin" && (
          <section
            key="weixin"
            id="channel-panel-weixin"
            role="tabpanel"
            className="channel-tab-panel"
            aria-label="微信详细配置"
          >
            <div>
              <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-brand">WEIXIN SETTINGS</p>
              <h3 className="text-base">微信详细配置</h3>
              <p className="mt-1.25 text-xs leading-[1.5] text-muted">首次使用建议留空凭证，启用并重启后扫码授权。</p>
            </div>

            {config.weixin.enabled && channels.weixin.status === "waiting_qr" && channels.weixin.qrcode_content && (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg b-success bg-[#f5fbf8] p-3.5 max-[640px]:grid-cols-1 max-[640px]:justify-items-center max-[640px]:text-center">
                <div>
                  <strong>请使用微信扫描二维码</strong>
                  <p className="mt-1.25 text-xs text-muted">扫描后请在手机上确认授权。</p>
                </div>
                <QRCode value={channels.weixin.qrcode_content} size={176} />
              </div>
            )}
            {config.weixin.enabled && channels.weixin.status === "scanned" && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                二维码已扫描，正在等待手机确认。
              </p>
            )}
            {config.weixin.enabled && channels.weixin.status === "waiting_verify_code" && (
              <div className="grid gap-3 rounded-lg b-success bg-[#f5fbf8] p-3.5">
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  请输入微信显示的数字验证码
                  <Input
                    value={verifyCode}
                    inputMode="numeric"
                    onChange={(event) => setVerifyCode(event.target.value)}
                  />
                </label>
                <button
                  className="w-fit inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-3.5 py-2.5 text-sm font-700 text-white hover:bg-brand-dark disabled:cursor-wait disabled:opacity-65"
                  disabled={submitting || !verifyCode.trim()}
                  onClick={submitVerifyCode}
                >
                  提交验证码
                </button>
                {verifyError && (
                  <p className="rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
                    {verifyError}
                  </p>
                )}
              </div>
            )}
            {config.weixin.enabled && channels.weixin.status === "ready" && (
              <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                微信渠道已连接。
              </p>
            )}
            {config.weixin.enabled && channels.weixin.error && (
              <p className="rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
                {channels.weixin.error}
              </p>
            )}

            <div className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
              <div className="rounded-[10px] b-success bg-[#f5fbf8] p-4 text-xs leading-[1.7] text-[#416050]">
                <div className="mb-2 flex items-center gap-2">
                  <strong className="text-sm text-[#294051]">扫码授权</strong>
                  <span className="rounded-full bg-[#dcefe8] px-2 py-0.5 text-[10px] font-700 text-brand">推荐</span>
                </div>
                <p>保持右侧两个凭证字段为空，启用渠道并保存配置，然后重启服务。</p>
                <p className="mt-2">重启后，本页面会显示微信授权二维码；扫码成功后凭证将自动保存。</p>
              </div>
              <div className="grid content-start gap-3.75 rounded-[10px] bg-[#f8fafb] p-4">
                <div>
                  <strong className="text-sm text-[#294051]">手动配置</strong>
                  <span className="ml-2 text-[11px] font-400 text-muted">可选</span>
                </div>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  Bot 账号 ID
                  <Input
                    value={config.weixin.account_id ?? ""}
                    onChange={(event) => updateWeixin({ account_id: event.target.value })}
                  />
                </label>
                <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
                  Bot Token
                  <Input.Password
                    value={config.weixin.token ?? ""}
                    onChange={(event) => updateWeixin({ token: event.target.value })}
                  />
                </label>
                <p className="text-[11px] leading-[1.5] text-muted">Bot Token 属于敏感凭证，请勿截图或分享。</p>
              </div>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}
