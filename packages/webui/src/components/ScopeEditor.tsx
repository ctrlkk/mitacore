import { Plus, X } from "lucide-react";
import { useState } from "react";
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
    <section className="scope-card">
      <div className="scope-heading">
        <div>
          <h3>{label}</h3>
          <p>控制允许与机器人互动的对象范围。</p>
        </div>
        <div className="segmented" aria-label={`${label} 访问模式`}>
          <button
            className={value.mode === "whitelist" ? "selected" : ""}
            onClick={() => onChange({ ...value, mode: "whitelist" })}
          >
            白名单
          </button>
          <button
            className={value.mode === "blacklist" ? "selected" : ""}
            onClick={() => onChange({ ...value, mode: "blacklist" })}
          >
            黑名单
          </button>
        </div>
      </div>
      <div className="scope-control">
        <div className="tag-list">
          {value.ids.map((id) => (
            <span key={id}>
              {id}
              <button
                aria-label={`删除 ${id}`}
                onClick={() => onChange({ ...value, ids: value.ids.filter((item) => item !== id) })}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          {!value.ids.length && <em>尚未添加 ID</em>}
        </div>
        <div className="inline-add">
          <input
            value={draft}
            placeholder="输入 ID，按回车添加"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addId()}
          />
          <button aria-label="添加 ID" onClick={addId}>
            <Plus size={17} />
            添加
          </button>
        </div>
      </div>
    </section>
  );
}
