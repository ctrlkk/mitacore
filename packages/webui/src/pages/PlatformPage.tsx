import type { Config } from "../types";
import { ScopeEditor } from "../components/ScopeEditor";

type Props = { config: Config; setConfig: React.Dispatch<React.SetStateAction<Config>> };

export function PlatformPage({ config, setConfig }: Props) {
  const updateNapcat = (patch: Partial<Config["napcat"]>) =>
    setConfig((value) => ({ ...value, napcat: { ...value.napcat, ...patch } }));
  const updateWeixin = (patch: Partial<Config["weixin"]>) =>
    setConfig((value) => ({ ...value, weixin: { ...value.weixin, ...patch } }));
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
                <p className="notice">扫码登录接口将在后端接入时显示在这里。现有凭证仍可在下方管理。</p>
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
