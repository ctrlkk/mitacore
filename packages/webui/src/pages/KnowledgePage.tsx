import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";

type KnowledgeNote = {
  path: string;
  title: string;
  folder: string;
  size: number;
  updated_at: number;
  links: string[];
};

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

export function KnowledgePage() {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadIndex = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/knowledge");
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "读取知识库失败"));
      setNotes((payload.notes ?? []) as KnowledgeNote[]);
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "读取知识库失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadIndex();
  }, []);

  const matchedNotes = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return notes;
    return notes.filter((note) => `${note.title}\n${note.path}`.toLocaleLowerCase().includes(keyword));
  }, [notes, search]);

  return (
    <div className="flex min-h-[calc(100vh-96px)] flex-col px-[clamp(16px,3vw,44px)] pb-5 pt-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="relative block min-w-[min(100%,320px)] flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
          <input
            className="h-10 w-full rounded-lg border border-[#d3dbe1] bg-white pl-9 pr-3 text-sm outline-none transition focus:border-brand focus:ring-3 focus:ring-[#21806b17]"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索知识节点"
            type="search"
          />
        </label>
        <button
          className="inline-flex items-center gap-2 rounded-lg bg-[#e9eff2] px-3 py-2.5 text-xs font-700 text-[#294051] hover:bg-[#dce5e9] disabled:cursor-wait disabled:opacity-65"
          disabled={loading}
          onClick={() => void loadIndex()}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} size={15} />
          刷新图谱
        </button>
      </div>
      {error && <p className="mb-3 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs text-[#922e2e]">{error}</p>}
      <div className="mb-3 flex items-center gap-2 text-xs text-muted">
        {loading ? (
          <LoaderCircle className="animate-spin" size={14} />
        ) : (
          <span className="h-2 w-2 rounded-full bg-brand" />
        )}
        <span>{loading ? "正在索引知识库…" : `显示 ${matchedNotes.length} / ${notes.length} 个知识节点`}</span>
      </div>
      <div className="min-h-[620px] flex-1">
        <KnowledgeGraph notes={notes} search={search} />
      </div>
    </div>
  );
}
