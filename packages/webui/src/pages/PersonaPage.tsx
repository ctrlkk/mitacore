import { Check, FileText, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkdownEditor } from "@/components/MarkdownEditor";

type SaveState = "idle" | "saving" | "saved";

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

export function PersonaPage() {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const dirty = content !== savedContent;
  const stats = useMemo(() => {
    const characters = content.length;
    const lines = content ? content.split("\n").length : 0;
    return { characters, lines };
  }, [content]);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/persona");
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "读取人设文件失败"));
      setContent(payload.content ?? "");
      setSavedContent(payload.content ?? "");
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "读取人设文件失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [dirty]);

  const save = async () => {
    setSaveState("saving");
    setError("");
    try {
      const response = await fetch("/api/persona", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "保存人设文件失败"));
      setSavedContent(content);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (exception) {
      setSaveState("idle");
      setError(exception instanceof Error ? exception.message : "保存人设文件失败");
    }
  };

  if (loading) {
    return (
      <p className="flex min-h-70 items-center justify-center gap-2 text-sm text-muted">
        <LoaderCircle className="animate-spin" size={18} />
        正在读取人设文件…
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-[1240px] px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <section className="overflow-hidden rounded-xl b-ui bg-white">
        <div className="flex items-center justify-between gap-4 bb-ui px-5 py-4 max-[640px]:items-start max-[640px]:flex-col">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#e8f5f1] text-brand">
              <FileText size={19} />
            </span>
            <div className="min-w-0">
              <strong className="block text-sm">角色核心提示词</strong>
              <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted">
                prompts/role.txt
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9] disabled:opacity-50"
              disabled={!dirty || saveState === "saving"}
              onClick={() => setContent(savedContent)}
            >
              <RotateCcw size={16} />
              撤销修改
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-3.5 py-2.5 text-sm font-700 text-white hover:bg-brand-dark disabled:opacity-50"
              disabled={!dirty || saveState === "saving"}
              onClick={save}
            >
              {saveState === "saving" ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : saveState === "saved" ? (
                <Check size={16} />
              ) : (
                <Save size={16} />
              )}
              {saveState === "saving" ? "正在保存" : saveState === "saved" ? "已保存" : "保存人设"}
            </button>
          </div>
        </div>
        {error && <p className="m-4 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs text-[#922e2e]">{error}</p>}
        <MarkdownEditor
          value={content}
          path="prompts/role.txt"
          height="calc(100vh - 280px)"
          onChange={setContent}
          onSave={save}
        />
        <footer className="flex items-center justify-between gap-4 border-t border-[#e3e6eb] bg-white px-5 py-3 text-[11px] text-muted">
          <span>{dirty ? "有未保存的修改" : "内容已同步"}</span>
          <span className="font-mono">
            {stats.lines} 行 · {stats.characters} 字符
          </span>
        </footer>
      </section>
    </div>
  );
}
