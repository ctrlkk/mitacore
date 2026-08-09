import type { Config } from "../types";
import { ScopeEditor } from "../components/ScopeEditor";
import { Input, QRCode, Select, Switch } from "antd";
import { useEffect, useState } from "react";
import { useChannels } from "../hooks/useChannels";

type Props = {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  reloadConfig(): Promise<void>;
};

export function PlatformPage({ config, setConfig, reloadConfig }: Props) {
  const channels = useChannels();
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (channels.weixin.status === "ready") void reloadConfig();
  }, [channels.weixin.status, reloadConfig]);
  const updateNapcat = (patch: Partial<Config["napcat"]>) =>
    setConfig((value) => ({ ...value, napcat: { ...value.napcat, ...patch } }));
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
    <div className="mx-auto grid max-w-[1240px] gap-5 px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5">
          <div>
            <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">CHANNELS</p>
            <h2 className="text-lg tracking-[-0.02em]">消息渠道</h2>
            <p className="mt-1.25 text-xs leading-[1.5] text-muted">每个渠道独立启用；至少保留一个渠道。</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
          <section className="grid content-start gap-3.75 rounded-[10px] b-ui p-4.5">
            <div className="flex justify-between gap-3">
              <div>
                <h3 className="text-sm">QQ / NapCat</h3>
                <p className="mt-1.25 text-xs leading-[1.5] text-muted">通过 NapCat 接收 QQ 消息。</p>
              </div>
              <Switch checked={config.napcat.enabled} onChange={(enabled) => updateNapcat({ enabled })} />
            </div>
            {config.napcat.enabled && (
              <>
                {channels.napcat.status === "starting" && !channels.napcat.embed_url && (
                  <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                    NapCat 正在启动…
                  </p>
                )}
                {channels.napcat.status === "starting" && channels.napcat.embed_url && (
                  <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                    NapCat WebUI 已启动，请在管理后台登录 QQ。
                  </p>
                )}
                {channels.napcat.embed_url && (
                  <div className="grid gap-3 rounded-lg b-success bg-[#f5fbf8] p-3.5">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <strong>NapCat 管理面板</strong>
                      <button
                        className="inline-flex w-fit items-center gap-1.25 bg-transparent py-0.75 text-xs font-700 text-brand"
                        onClick={() => window.open(channels.napcat.embed_url, "_blank", "noopener")}
                      >
                        打开管理后台
                      </button>
                    </div>
                  </div>
                )}
                {channels.napcat.status === "external" && (
                  <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                    外置 NapCat 不提供内嵌管理面板。
                  </p>
                )}
                {channels.napcat.error && (
                  <p className="rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
                    {channels.napcat.error}
                  </p>
                )}
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
                  NapCat 小技巧：给机器人 QQ 账号完成实名认证，可以大幅降低被强制下线的概率。
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
                </details>
              </>
            )}
          </section>
          <section className="grid content-start gap-3.75 rounded-[10px] b-ui p-4.5">
            <div className="flex justify-between gap-3">
              <div>
                <h3 className="text-sm">微信</h3>
                <p className="mt-1.25 text-xs leading-[1.5] text-muted">iLink Bot 渠道，支持扫码授权。</p>
              </div>
              <Switch checked={config.weixin.enabled} onChange={(enabled) => updateWeixin({ enabled })} />
            </div>
            {config.weixin.enabled && (
              <>
                {channels.weixin.status === "waiting_qr" && channels.weixin.qrcode_content && (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg b-success bg-[#f5fbf8] p-3.5">
                    <div>
                      <strong>请使用微信扫描二维码</strong>
                      <p className="mt-1.25 text-xs text-muted">扫描后请在手机上确认授权。</p>
                    </div>
                    <QRCode value={channels.weixin.qrcode_content} size={176} />
                  </div>
                )}
                {channels.weixin.status === "scanned" && (
                  <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                    二维码已扫描，正在等待手机确认。
                  </p>
                )}
                {channels.weixin.status === "waiting_verify_code" && (
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
                {channels.weixin.status === "ready" && (
                  <p className="rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
                    微信渠道已连接。
                  </p>
                )}
                {channels.weixin.error && (
                  <p className="rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
                    {channels.weixin.error}
                  </p>
                )}
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
              </>
            )}
          </section>
        </div>
      </section>
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5">
          <div>
            <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">ACCESS</p>
            <h2 className="text-lg tracking-[-0.02em]">访问范围</h2>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 max-[1120px]:grid-cols-2 max-[820px]:grid-cols-1">
          <ScopeEditor label="QQ 群聊" value={config.napcat.groups} onChange={(groups) => updateNapcat({ groups })} />
          <ScopeEditor
            label="QQ 私聊"
            value={config.napcat.private_chats}
            onChange={(private_chats) => updateNapcat({ private_chats })}
          />
          <ScopeEditor
            label="QQ群内成员"
            value={config.napcat.group_members}
            onChange={(group_members) => updateNapcat({ group_members })}
          />
        </div>
      </section>
    </div>
  );
}
