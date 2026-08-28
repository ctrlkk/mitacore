import type { WeixinCredentials } from "channels/weixin";

export type WeixinStatus = "idle" | "waiting_qr" | "scanned" | "waiting_verify_code" | "ready" | "failed";
export type NapCatStatus =
  | "idle"
  | "starting"
  | "waiting_qr"
  | "connecting"
  | "ready"
  | "offline"
  | "external"
  | "failed";
export type QQBotStatus = "idle" | "waiting_qr" | "connecting" | "ready" | "failed";
export type ChannelSnapshot = {
  weixin: { status: WeixinStatus; qrcode_content?: string; error?: string };
  napcat: {
    status: NapCatStatus;
    qrcode_content?: string;
    embed_url?: string;
    login_error?: string;
    error?: string;
  };
  qqbot: { status: QQBotStatus; qrcode_content?: string; error?: string };
};

type Listener = (snapshot: ChannelSnapshot) => void;

export class ChannelController {
  private readonly listeners = new Set<Listener>();
  private verifyCodeResolver?: (code: string) => void;
  private snapshot: ChannelSnapshot = {
    weixin: { status: "idle" },
    napcat: { status: "idle" },
    qqbot: { status: "idle" },
  };

  getSnapshot(): ChannelSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateWeixin(patch: Partial<ChannelSnapshot["weixin"]>) {
    this.snapshot = { ...this.snapshot, weixin: { ...this.snapshot.weixin, ...patch } };
    this.emit();
  }

  updateNapcat(patch: Partial<ChannelSnapshot["napcat"]>) {
    this.snapshot = { ...this.snapshot, napcat: { ...this.snapshot.napcat, ...patch } };
    this.emit();
  }

  updateQQBot(patch: Partial<ChannelSnapshot["qqbot"]>) {
    this.snapshot = { ...this.snapshot, qqbot: { ...this.snapshot.qqbot, ...patch } };
    this.emit();
  }

  waitForVerifyCode(): Promise<string> {
    return new Promise((resolve) => {
      this.verifyCodeResolver = resolve;
    });
  }

  submitVerifyCode(code: string): boolean {
    const resolver = this.verifyCodeResolver;
    if (!resolver) return false;
    this.verifyCodeResolver = undefined;
    resolver(code);
    return true;
  }

  async loginWithQr(login: (waitForVerifyCode: () => Promise<string>) => Promise<WeixinCredentials>) {
    this.updateWeixin({ status: "waiting_qr", error: undefined });
    try {
      return await login(() => this.waitForVerifyCode());
    } catch (error) {
      this.updateWeixin({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export const channelController = new ChannelController();
