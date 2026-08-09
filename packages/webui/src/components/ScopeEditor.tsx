import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Input } from "antd";
import type { Scope } from "../types";

type Props = { label: string; value: Scope; onChange: (value: Scope) => void };

export function ScopeEditor({ label, value, onChange }: Props) {
  const [draft, setDraft] = useState("");
  const addId = () => {
    const id = draft.trim();
    if (!id || value.ids.includes(id)) return;
    onChange({ ...value, ids: [...value.ids, id] });
    setDraft("");
  };
  return (
    <section className="grid gap-4 rounded-[10px] b-ui bg-[#fbfcfd] p-4.25">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm">{label}</h3>
          <p className="mt-1.25 text-xs leading-[1.5] text-muted">控制允许与机器人互动的对象范围。</p>
        </div>
        <div className="flex w-fit flex-none rounded-[7px] bg-[#edf1f3] p-0.75" aria-label={`${label} 访问模式`}>
          <button
            className={`rounded-[5px] px-2.25 py-1.5 text-[11px] text-[#667785] ${value.mode === "whitelist" ? "bg-white text-[#173f36] shadow-[0_1px_2px_#17212b16]" : ""}`}
            onClick={() => onChange({ ...value, mode: "whitelist" })}
          >
            白名单
          </button>
          <button
            className={`rounded-[5px] px-2.25 py-1.5 text-[11px] text-[#667785] ${value.mode === "blacklist" ? "bg-white text-[#173f36] shadow-[0_1px_2px_#17212b16]" : ""}`}
            onClick={() => onChange({ ...value, mode: "blacklist" })}
          >
            黑名单
          </button>
        </div>
      </div>
      <div className="grid gap-2.5">
        <div className="flex min-h-7.5 flex-wrap content-center gap-1.5">
          {value.ids.map((id) => (
            <span
              className="inline-flex items-center gap-0.75 rounded-full bg-[#e2f4ed] py-1 pl-2 pr-1.5 text-[11px] text-[#245949]"
              key={id}
            >
              {id}
              <button
                className="grid place-items-center bg-transparent p-0 text-inherit"
                aria-label={`删除 ${id}`}
                onClick={() => onChange({ ...value, ids: value.ids.filter((item) => item !== id) })}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          {!value.ids.length && <em className="text-[11px] text-[#91a0ac] not-italic">尚未添加 ID</em>}
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-1.5">
          <Input
            value={draft}
            placeholder="输入 ID，按回车添加"
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={addId}
          />
          <button
            className="inline-flex place-items-center items-center justify-center gap-1.25 rounded-[7px] bg-brand px-2.75 text-white hover:bg-brand-dark"
            aria-label="添加 ID"
            onClick={addId}
          >
            <Plus size={17} />
            添加
          </button>
        </div>
      </div>
    </section>
  );
}
