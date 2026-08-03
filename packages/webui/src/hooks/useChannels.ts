import { useEffect, useState } from "react";

export type ChannelSnapshot = {
  weixin: {
    status: "idle" | "waiting_qr" | "scanned" | "waiting_verify_code" | "ready" | "failed";
    qrcode_content?: string;
    error?: string;
  };
  napcat: {
    status: "idle" | "starting" | "ready" | "external" | "failed";
    embed_url?: string;
    error?: string;
  };
};

const initialSnapshot: ChannelSnapshot = {
  weixin: { status: "idle" },
  napcat: { status: "idle" },
};

export function useChannels() {
  const [channels, setChannels] = useState<ChannelSnapshot>(initialSnapshot);

  useEffect(() => {
    let active = true;
    void fetch("/api/runtime")
      .then(async (response) => {
        if (!response.ok) throw new Error("无法获取渠道状态");
        return (await response.json()) as ChannelSnapshot;
      })
      .then((snapshot) => {
        if (active) setChannels(snapshot);
      })
      .catch(() => undefined);

    const events = new EventSource("/api/runtime/events");
    events.addEventListener("runtime", (event) => setChannels(JSON.parse(event.data) as ChannelSnapshot));
    return () => {
      active = false;
      events.close();
    };
  }, []);

  return channels;
}
