import type { Config } from "../types";
import { ScopeEditor } from "../components/ScopeEditor";
import { QRCode } from "antd";
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
    <div className="content">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">CHANNELS</p>
            <h2>消息渠道</h2>
            <p>每个渠道独立启用；至少保留一个渠道。</p>
          </div>
        </div>
        <div className="channel-grid">
          <section className="channel">
            <div className="channel-title">
              <div>
                <h3>QQ / NapCat</h3>
                <p>通过 NapCat 接收 QQ 消息。</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={config.napcat.enabled}
                  onChange={(event) => updateNapcat({ enabled: event.target.checked })}
                />
                <span />
              </label>
            </div>
            {config.napcat.enabled && (
              <>
                {channels.napcat.status === "starting" && <p className="notice">NapCat 正在启动…</p>}
                {channels.napcat.status === "ready" && channels.napcat.embed_url && (
                  <div className="napcat-panel">
                    <div className="panel-heading">
                      <strong>NapCat 管理面板</strong>
                      <a href={channels.napcat.embed_url} target="_blank" rel="noreferrer">
                        打开管理后台
                      </a>
                    </div>
                  </div>
                )}
                {channels.napcat.status === "external" && <p className="notice">外置 NapCat 不提供内嵌管理面板。</p>}
                {channels.napcat.error && <p className="notice error">{channels.napcat.error}</p>}
                <label className="field">
                  机器人 QQ 号
                  <input
                    value={config.napcat.qq_id ?? ""}
                    inputMode="numeric"
                    onChange={(event) => updateNapcat({ qq_id: event.target.value })}
                    placeholder="请输入 QQ 号"
                  />
                </label>
                <details>
                  <summary>外部 NapCat 连接设置</summary>
                  <label className="field">
                    WebSocket 地址
                    <input
                      value={config.napcat.ws_url ?? ""}
                      onChange={(event) => updateNapcat({ ws_url: event.target.value })}
                      placeholder="ws://localhost:3001"
                    />
                  </label>
                  <label className="field">
                    Token
                    <input
                      type="password"
                      value={config.napcat.token ?? ""}
                      onChange={(event) => updateNapcat({ token: event.target.value })}
                    />
                  </label>
                </details>
              </>
            )}
          </section>
          <section className="channel">
            <div className="channel-title">
              <div>
                <h3>微信</h3>
                <p>iLink Bot 渠道，支持扫码授权。</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={config.weixin.enabled}
                  onChange={(event) => updateWeixin({ enabled: event.target.checked })}
                />
                <span />
              </label>
            </div>
            {config.weixin.enabled && (
              <>
                {channels.weixin.status === "waiting_qr" && channels.weixin.qrcode_content && (
                  <div className="weixin-login">
                    <div>
                      <strong>请使用微信扫描二维码</strong>
                      <p>扫描后请在手机上确认授权。</p>
                    </div>
                    <QRCode value={channels.weixin.qrcode_content} size={176} />
                  </div>
                )}
                {channels.weixin.status === "scanned" && <p className="notice">二维码已扫描，正在等待手机确认。</p>}
                {channels.weixin.status === "waiting_verify_code" && (
                  <div className="verify-code">
                    <label className="field">
                      请输入微信显示的数字验证码
                      <input
                        value={verifyCode}
                        inputMode="numeric"
                        onChange={(event) => setVerifyCode(event.target.value)}
                      />
                    </label>
                    <button className="button" disabled={submitting || !verifyCode.trim()} onClick={submitVerifyCode}>
                      提交验证码
                    </button>
                    {verifyError && <p className="notice error">{verifyError}</p>}
                  </div>
                )}
                {channels.weixin.status === "ready" && <p className="notice success">微信渠道已连接。</p>}
                {channels.weixin.error && <p className="notice error">{channels.weixin.error}</p>}
                <label className="field">
                  Bot 账号 ID
                  <input
                    value={config.weixin.account_id ?? ""}
                    onChange={(event) => updateWeixin({ account_id: event.target.value })}
                  />
                </label>
                <label className="field">
                  Bot Token
                  <input
                    type="password"
                    value={config.weixin.token ?? ""}
                    onChange={(event) => updateWeixin({ token: event.target.value })}
                  />
                </label>
              </>
            )}
          </section>
        </div>
      </section>
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">ACCESS</p>
            <h2>访问范围</h2>
          </div>
        </div>
        <div className="scope-grid">
          <ScopeEditor label="QQ 群聊" value={config.napcat.groups} onChange={(groups) => updateNapcat({ groups })} />
          <ScopeEditor
            label="QQ 私聊"
            value={config.napcat.private_chats}
            onChange={(private_chats) => updateNapcat({ private_chats })}
          />
          <ScopeEditor label="微信用户" value={config.weixin.users} onChange={(users) => updateWeixin({ users })} />
        </div>
      </section>
    </div>
  );
}
