import { Alert, InputNumber } from "antd";
import type { Config } from "@/types";

type Props = {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
};

export function ModePage({ config, setConfig }: Props) {
  return (
    <div className="mx-auto grid max-w-[1240px] gap-5 px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <Alert
        type="warning"
        message="非专业用户请保持默认配置"
        description="修改队列参数可能影响消息的合并和响应方式。"
      />
      <section className="rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="mb-5.5">
          <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">MODE</p>
          <h2 className="text-lg tracking-[-0.02em]">运行模式</h2>
        </div>
        <div className="grid gap-4">
          <section className="grid content-start gap-3.75 rounded-[10px] b-ui p-4.5">
            <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
              单个会话单次处理前的消息等待队列上限
              <InputNumber
                className="w-full"
                min={1}
                step={1}
                value={config.max_queue}
                onChange={(maxQueue) => {
                  if (maxQueue === null) return;
                  if (Number.isInteger(maxQueue) && maxQueue > 0) {
                    setConfig((value) => ({ ...value, max_queue: maxQueue }));
                  }
                }}
              />
              <span className="text-xs font-400 text-muted">
                用于暂存并合并下一次处理的消息，不是模型上下文长度；超出上限时会丢弃最早的消息。
              </span>
            </label>
          </section>
          <section className="grid content-start gap-3.75 rounded-[10px] b-ui p-4.5">
            <label className="grid gap-1.75 text-xs font-700 text-[#40515f]">
              消息合并等待时间（秒）
              <InputNumber
                className="w-full"
                min={1}
                max={10}
                step={1}
                value={config.debounce_ms / 1000}
                onChange={(debounceSeconds) => {
                  if (debounceSeconds === null) return;
                  if (Number.isInteger(debounceSeconds) && debounceSeconds >= 1 && debounceSeconds <= 10) {
                    setConfig((value) => ({ ...value, debounce_ms: debounceSeconds * 1000 }));
                  }
                }}
              />
              <span className="text-xs font-400 text-muted">
                收到最后一条消息后等待指定时间再判断是否处理，以便合并连续消息；可设为 1 至 10 秒。
              </span>
            </label>
          </section>
        </div>
      </section>
    </div>
  );
}
