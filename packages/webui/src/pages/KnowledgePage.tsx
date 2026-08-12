import {
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  LoaderCircle,
  Network,
  RefreshCw,
  Save,
  Search,
} from "lucide-react";
import { Input, Modal, Tree, type TreeDataNode } from "antd";
import { useEffect, useMemo, useState } from "react";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import { MarkdownEditor } from "@/components/MarkdownEditor";

type KnowledgeNote = {
  path: string;
  title: string;
  folder: string;
  size: number;
  updated_at: number;
  links: string[];
};

type MutableTreeNode = TreeDataNode & { children?: MutableTreeNode[] };

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

function getFolderKeys(path: string) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => `folder:${parts.slice(0, index + 1).join("/")}`);
}

function createTreeData(notes: KnowledgeNote[]) {
  const roots: MutableTreeNode[] = [];
  const folders = new Map<string, MutableTreeNode>();

  for (const note of notes) {
    const parts = note.path.split("/");
    let children = roots;
    for (let index = 0; index < parts.length - 1; index++) {
      const folderPath = parts.slice(0, index + 1).join("/");
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { key: `folder:${folderPath}`, title: parts[index]!, children: [] };
        folders.set(folderPath, folder);
        children.push(folder);
      }
      children = folder.children!;
    }
    children.push({
      key: note.path,
      isLeaf: true,
      title: (
        <span className="flex min-w-0 items-center gap-2 pr-1">
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{note.title}</span>
          {note.links.length > 0 && <span className="font-mono text-[9px] text-muted">{note.links.length}</span>}
        </span>
      ),
    });
  }

  const sortNodes = (nodes: MutableTreeNode[]) => {
    nodes.sort((left, right) => {
      if (Boolean(left.isLeaf) !== Boolean(right.isLeaf)) return left.isLeaf ? 1 : -1;
      return String(left.key).localeCompare(String(right.key), "zh-CN");
    });
    nodes.forEach((node) => node.children && sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

function collectFolderKeys(nodes: MutableTreeNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.isLeaf) return [];
    return [String(node.key), ...collectFolderKeys(node.children ?? [])];
  });
}

export function KnowledgePage() {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"editor" | "graph">("editor");
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loading, setLoading] = useState(true);
  const [noteLoading, setNoteLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const dirty = content !== savedContent;

  const loadIndex = async (preferredPath?: string) => {
    setLoading(true);
    try {
      const response = await fetch("/api/knowledge");
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "读取知识库失败"));
      const nextNotes = (payload.notes ?? []) as KnowledgeNote[];
      setNotes(nextNotes);
      setSelectedPath(
        (current) =>
          preferredPath ||
          current ||
          nextNotes.find((note) => note.path === "MEMORY.md")?.path ||
          nextNotes[0]?.path ||
          "",
      );
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

  useEffect(() => {
    if (!selectedPath) return;
    const loadNote = async () => {
      setNoteLoading(true);
      try {
        const response = await fetch(`/api/knowledge/note?path=${encodeURIComponent(selectedPath)}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(getErrorMessage(payload, "读取笔记失败"));
        setContent(payload.content ?? "");
        setSavedContent(payload.content ?? "");
        setError("");
      } catch (exception) {
        setError(exception instanceof Error ? exception.message : "读取笔记失败");
      } finally {
        setNoteLoading(false);
      }
    };
    void loadNote();
  }, [selectedPath]);

  useEffect(() => {
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [dirty]);

  const visibleNotes = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return notes;
    return notes.filter((note) => `${note.title}\n${note.path}`.toLocaleLowerCase().includes(keyword));
  }, [notes, search]);
  const treeData = useMemo(() => createTreeData(visibleNotes), [visibleNotes]);

  useEffect(() => {
    if (search.trim()) {
      setExpandedKeys(collectFolderKeys(treeData));
      return;
    }
    setExpandedKeys(getFolderKeys(selectedPath));
  }, [search, selectedPath, treeData]);

  const selectNote = (path: string) => {
    if (path === selectedPath) {
      setView("editor");
      return;
    }
    if (dirty && !window.confirm("当前笔记有未保存的修改，确定要离开吗？")) return;
    setSelectedPath(path);
    setView("editor");
  };

  const saveNote = async () => {
    if (!selectedPath || !dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/knowledge/note", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selectedPath, content }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "保存笔记失败"));
      setSavedContent(content);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
      await loadIndex(selectedPath);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "保存笔记失败");
    } finally {
      setSaving(false);
    }
  };

  const createNote = async () => {
    const path = `${newPath.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\.md$/i, "")}.md`;
    if (path === ".md") return;
    setSaving(true);
    try {
      const response = await fetch("/api/knowledge/note", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          content: `# ${path.split("/").at(-1)!.slice(0, -3)}\n\n`,
          create_only: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "创建笔记失败"));
      setCreateOpen(false);
      setNewPath("");
      await loadIndex(payload.path);
      setView("editor");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "创建笔记失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] px-[clamp(16px,3vw,44px)] pb-12 pt-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg bg-[#e9eff2] p-1">
          <button
            className={`rounded-md px-3 py-2 text-xs font-700 ${view === "editor" ? "bg-white text-brand shadow-sm" : "text-muted"}`}
            onClick={() => setView("editor")}
          >
            <FileText className="mr-1.5 inline" size={15} />
            编辑器
          </button>
          <button
            className={`rounded-md px-3 py-2 text-xs font-700 ${view === "graph" ? "bg-white text-brand shadow-sm" : "text-muted"}`}
            onClick={() => setView("graph")}
          >
            <Network className="mr-1.5 inline" size={15} />
            关系图
          </button>
        </div>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-[#e9eff2] px-3 py-2.5 text-xs font-700 text-[#294051] hover:bg-[#dce5e9]"
            onClick={() => void loadIndex(selectedPath)}
          >
            <RefreshCw size={15} />
            刷新
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-3 py-2.5 text-xs font-700 text-white hover:bg-brand-dark"
            onClick={() => setCreateOpen(true)}
          >
            <FilePlus2 size={15} />
            新建笔记
          </button>
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs text-[#922e2e]">{error}</p>}
      <div className="grid grid-cols-[238px_minmax(0,1fr)] gap-3 max-[860px]:grid-cols-1">
        <aside className="max-h-[calc(100vh-190px)] overflow-hidden rounded-xl b-ui bg-white max-[860px]:max-h-80">
          <div className="px-2.5 pb-2 pt-2.5 bb-ui">
            <Input
              prefix={<Search size={15} />}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索笔记"
              allowClear
            />
            <p className="mb-0 mt-1.5 px-1 text-[10px] text-muted">
              {visibleNotes.length} / {notes.length} 篇 Markdown 笔记
            </p>
          </div>
          <div className="knowledge-tree max-h-[calc(100vh-268px)] overflow-y-auto px-1.5 py-1.5 max-[860px]:max-h-56">
            {loading ? (
              <p className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
                <LoaderCircle className="animate-spin" size={15} />
                正在索引…
              </p>
            ) : (
              <Tree
                showLine
                showIcon
                treeData={treeData}
                expandedKeys={expandedKeys}
                selectedKeys={[]}
                icon={(node) => (node.isLeaf ? <FileText size={13} /> : null)}
                switcherIcon={(node) =>
                  node.isLeaf ? null : node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                }
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={(keys, info) => {
                  if (info.node.isLeaf) {
                    if (keys[0]) selectNote(String(keys[0]));
                    return;
                  }
                  const folderKey = String(info.node.key);
                  setExpandedKeys((value) =>
                    value.includes(folderKey) ? value.filter((key) => key !== folderKey) : [...value, folderKey],
                  );
                }}
              />
            )}
          </div>
        </aside>
        <main className="min-w-0">
          {view === "graph" ? (
            <KnowledgeGraph notes={notes} search={search} selectedPath={selectedPath} onSelect={selectNote} />
          ) : (
            <section className="overflow-hidden rounded-xl b-ui bg-white">
              <header className="flex min-h-16 items-center justify-between gap-3 bb-ui px-4 py-3 max-[640px]:items-start max-[640px]:flex-col">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-[10px] text-muted">
                    {(selectedPath || "未选择笔记").split("/").map((part, index) => (
                      <span className="flex items-center gap-1" key={`${part}-${index}`}>
                        {index > 0 && <ChevronRight size={10} />}
                        {part}
                      </span>
                    ))}
                  </div>
                  <strong className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                    {notes.find((note) => note.path === selectedPath)?.title || "选择一篇笔记"}
                  </strong>
                </div>
                <button
                  className="inline-flex items-center gap-2 rounded-lg bg-brand px-3.5 py-2.5 text-xs font-700 text-white hover:bg-brand-dark disabled:opacity-50"
                  disabled={!dirty || saving || !selectedPath}
                  onClick={saveNote}
                >
                  {saving ? (
                    <LoaderCircle className="animate-spin" size={15} />
                  ) : saved ? (
                    <Check size={15} />
                  ) : (
                    <Save size={15} />
                  )}
                  {saving ? "正在保存" : saved ? "已保存" : "保存笔记"}
                </button>
              </header>
              {noteLoading ? (
                <p className="flex min-h-[calc(100vh-290px)] items-center justify-center gap-2 text-xs text-muted">
                  <LoaderCircle className="animate-spin" size={16} />
                  正在读取笔记…
                </p>
              ) : (
                <>
                  <MarkdownEditor
                    value={content}
                    path={selectedPath}
                    height="calc(100vh - 318px)"
                    disabled={!selectedPath}
                    onChange={setContent}
                    onSave={saveNote}
                  />
                  <footer className="flex items-center justify-between bg-[#176c58] px-3 py-1.5 font-mono text-[10px] text-white/85">
                    <span>Markdown · UTF-8 · Ctrl+S 保存</span>
                    <span>{dirty ? "● 未保存" : `${content.length} 字符`}</span>
                  </footer>
                </>
              )}
            </section>
          )}
        </main>
      </div>
      <Modal
        title="新建知识库笔记"
        open={createOpen}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        onOk={createNote}
        onCancel={() => !saving && setCreateOpen(false)}
      >
        <p className="mt-0 text-xs leading-5 text-muted">
          可填写目录，例如 <code>01-角色/新角色</code>；扩展名会自动补全为 .md。
        </p>
        <Input
          autoFocus
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          onPressEnter={createNote}
          placeholder="目录/笔记名称"
        />
      </Modal>
    </div>
  );
}
