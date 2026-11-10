import { lazy, Suspense, useEffect, useState } from "react";
import { FileText, LoaderCircleIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const PersonaEditor = lazy(() =>
  import("@/components/PersonaEditor").then((module) => ({ default: module.PersonaEditor })),
);

type SaveState = "idle" | "saving" | "saved";

function getErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = data.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") {
    return fallback;
  }
  return error.message;
}

export function PersonaPage() {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const isDirty = content !== savedContent;
  const lineCount = content ? content.split("\n").length : 0;

  useEffect(() => {
    const controller = new AbortController();

    async function loadPersona() {
      try {
        const response = await fetch("/api/persona", { signal: controller.signal });
        const data = (await response.json().catch(() => undefined)) as { content?: unknown } | undefined;
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载人设"));
        const nextContent = typeof data?.content === "string" ? data.content : "";
        setContent(nextContent);
        setSavedContent(nextContent);
        setError("");
      } catch (exception) {
        if (!controller.signal.aborted) setError(exception instanceof Error ? exception.message : "无法加载人设");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadPersona();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function warnBeforeLeave(event: BeforeUnloadEvent) {
      if (!isDirty) return;
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);

  async function savePersona() {
    if (!isDirty || isSaving) return;

    setIsSaving(true);
    setSaveState("saving");
    setError("");
    try {
      const response = await fetch("/api/persona", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(data, "保存人设失败"));
      setSavedContent(content);
      setSaveState("saved");
      toast.success("人设已保存");
    } catch (exception) {
      setSaveState("idle");
      setError(exception instanceof Error ? exception.message : "保存人设失败");
    } finally {
      setIsSaving(false);
    }
  }

  function updateContent(nextContent: string) {
    setContent(nextContent);
    if (saveState === "saved") setSaveState("idle");
  }

  if (isLoading) {
    return (
      <section className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-5 animate-spin" />
        正在加载人设
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-3 sm:p-4 max-lg:overflow-y-auto">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">人设编辑器</h1>
          <p className="text-sm text-muted-foreground">
            更换人设后请清理 <code>data/planner.json</code>、<code>data/chat.json</code>，否则可能不生效。
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setContent(savedContent)} disabled={!isDirty || isSaving}>
            <RefreshCwIcon data-icon="inline-start" />
            还原
          </Button>
          <Button size="sm" onClick={() => void savePersona()} disabled={!isDirty || isSaving}>
            {isSaving ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            {saveState === "saved" ? "已保存" : isSaving ? "正在保存" : "保存"}
          </Button>
        </div>
      </div>

      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card max-lg:min-h-[calc(100svh-14rem)] max-lg:flex-none"
        aria-labelledby="persona-editor-title"
      >
        <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <h2 id="persona-editor-title" className="font-medium">
              角色核心提示词
            </h2>
            <span className="truncate font-mono text-xs text-muted-foreground">data/prompts/role.txt</span>
          </div>
          <span className="text-xs text-muted-foreground">{isDirty ? "有未保存的修改" : "内容已同步"}</span>
        </div>
        {error ? (
          <p className="shrink-0 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive sm:px-4">{error}</p>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                正在加载编辑器
              </div>
            }
          >
            <PersonaEditor value={content} onChange={updateContent} onSave={() => void savePersona()} />
          </Suspense>
        </div>
        <footer className="flex shrink-0 items-center justify-end border-t px-3 py-2 font-mono text-xs text-muted-foreground sm:px-4">
          {lineCount} 行 · {content.length} 字符
        </footer>
      </section>
    </section>
  );
}
