import { useEffect, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type GraphData } from "react-force-graph-2d";
import { FileTextIcon, LoaderCircleIcon, Maximize2Icon, NetworkIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";
import "./KnowledgeGraphPage.css";

type KnowledgeNote = {
  path: string;
  title: string;
  folder: string;
  size: number;
  updated_at: number;
  links: string[];
};

type KnowledgeResponse = {
  notes: KnowledgeNote[];
  summary: { total: number; links: number };
};

type GraphNode = KnowledgeNote & {
  id: string;
  degree: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
};

type GraphLink = {
  source: string;
  target: string;
};

const emptyGraphData: GraphData<GraphNode, GraphLink> = { nodes: [], links: [] };

function getErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = data.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") {
    return fallback;
  }
  return error.message;
}

function isKnowledgeResponse(data: unknown): data is KnowledgeResponse {
  return (
    data !== null &&
    typeof data === "object" &&
    "notes" in data &&
    Array.isArray(data.notes) &&
    "summary" in data &&
    Boolean(data.summary) &&
    typeof data.summary === "object"
  );
}

function createGraphData(notes: KnowledgeNote[]): GraphData<GraphNode, GraphLink> {
  const paths = new Set(notes.map((note) => note.path));
  const degrees = new Map(notes.map((note) => [note.path, 0]));
  const links = notes.flatMap((note) =>
    note.links.flatMap((target) => {
      if (!paths.has(target)) return [];
      degrees.set(note.path, (degrees.get(note.path) ?? 0) + 1);
      degrees.set(target, (degrees.get(target) ?? 0) + 1);
      return [{ source: note.path, target }];
    }),
  );

  const nodes: GraphNode[] = notes.map((note) => ({ ...note, id: note.path, degree: degrees.get(note.path) ?? 0 }));
  const isolatedNodes = nodes.filter((node) => node.degree === 0);

  // 孤立笔记没有连线力约束；固定在外围以防被电荷力推离主图谱。
  isolatedNodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / isolatedNodes.length - Math.PI / 2;
    const radius = isolatedNodes.length === 1 ? 0 : 92 + Math.floor(index / 12) * 22;
    node.fx = Math.cos(angle) * radius;
    node.fy = Math.sin(angle) * radius;
  });

  return { nodes, links };
}

function getNodeId(node: string | number | { id?: string | number } | undefined) {
  return typeof node === "object" ? String(node?.id ?? "") : String(node ?? "");
}

function getNodeRadius(node: GraphNode) {
  if (node.degree === 0) return 2;
  return 2.5 + Math.min(4.5, Math.sqrt(node.degree) * 1.05);
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 102.4)) / 10} MB`;
}

function formatUpdatedAt(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(timestamp);
}

export function KnowledgeGraphPage() {
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink>>(undefined);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [graphData, setGraphData] = useState(emptyGraphData);
  const [summary, setSummary] = useState<KnowledgeResponse["summary"]>({ total: 0, links: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [hoveredPath, setHoveredPath] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const selectedNode = graphData.nodes.find((node) => node.id === selectedPath);
  const activePath = hoveredPath || selectedPath;
  const isDark = resolvedTheme === "dark";
  const isolatedCount = graphData.nodes.filter((node) => node.degree === 0).length;

  useEffect(() => {
    const container = graphContainerRef.current;
    if (!container) return;

    const updateSize = () => setSize({ width: container.clientWidth, height: container.clientHeight });
    updateSize();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadKnowledge() {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch("/api/knowledge", { signal: controller.signal });
        const data = (await response.json().catch(() => undefined)) as unknown;
        if (!response.ok) throw new Error(getErrorMessage(data, "无法加载知识库"));
        if (!isKnowledgeResponse(data)) throw new Error("知识库数据格式不正确");

        setGraphData(createGraphData(data.notes));
        setSummary(data.summary);
        setSelectedPath("");
        setHoveredPath("");
      } catch (exception) {
        if (!controller.signal.aborted) {
          setGraphData(emptyGraphData);
          setSummary({ total: 0, links: 0 });
          setError(exception instanceof Error ? exception.message : "无法加载知识库");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadKnowledge();
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    if (graphData.nodes.length === 0) return;

    const frame = requestAnimationFrame(() => {
      const graph = graphRef.current;
      const linkForce = graph?.d3Force("link");
      const chargeForce = graph?.d3Force("charge");
      linkForce?.distance?.(84);
      chargeForce?.strength?.(-72);
      graph?.d3ReheatSimulation();
      graph?.zoomToFit(500, 96);
    });
    return () => cancelAnimationFrame(frame);
  }, [graphData]);

  function drawNode(node: GraphNode, context: CanvasRenderingContext2D, globalScale: number) {
    const radius = getNodeRadius(node);
    const isActive = node.id === activePath;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
    context.fillStyle = isActive
      ? isDark
        ? "#fafaf9"
        : "#1c1917"
      : node.degree === 0
        ? isDark
          ? "#78716c"
          : "#a8a29e"
        : isDark
          ? "#d6d3d1"
          : "#57534e";
    context.fill();
    if (isActive) {
      context.lineWidth = 2 / globalScale;
      context.strokeStyle = isDark ? "#57534e" : "#d6d3d1";
      context.stroke();
    }

    if (globalScale < 1.1 && !isActive) return;
    context.font = `${11 / globalScale}px "Noto Sans SC", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = isDark ? "#f5f5f4" : "#292524";
    context.fillText(node.title, x, y + radius + 3 / globalScale);
  }

  function paintPointerArea(node: GraphNode, paintColor: string, context: CanvasRenderingContext2D) {
    context.beginPath();
    context.arc(node.x ?? 0, node.y ?? 0, getNodeRadius(node) + 3, 0, 2 * Math.PI);
    context.fillStyle = paintColor;
    context.fill();
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-3 sm:p-4 max-lg:overflow-y-auto">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">知识图谱</h1>
          <p className="text-sm text-muted-foreground">data/workspace/notepad</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{summary.total} 篇笔记</Badge>
          <Badge variant="secondary">{summary.links} 个链接</Badge>
          <Button size="sm" variant="outline" onClick={() => setReloadToken((token) => token + 1)} disabled={isLoading}>
            {isLoading ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            刷新
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => graphRef.current?.zoomToFit(400, 64)}
            disabled={!graphData.nodes.length}
          >
            <Maximize2Icon data-icon="inline-start" />
            适应视图
          </Button>
        </div>
      </div>

      <section
        aria-label="知识图谱画布"
        className="relative flex min-h-90 flex-1 overflow-hidden rounded-xl border bg-card max-lg:min-h-110 max-lg:flex-none"
      >
        <div
          ref={graphContainerRef}
          className="knowledge-graph-canvas min-h-0 flex-1"
          onPointerDown={(event) => {
            if (event.pointerType === "touch") event.stopPropagation();
          }}
        >
          {size.width > 0 && size.height > 0 ? (
            <ForceGraph2D<GraphNode, GraphLink>
              ref={graphRef}
              width={size.width}
              height={size.height}
              graphData={graphData}
              nodeId="id"
              backgroundColor="rgba(0, 0, 0, 0)"
              nodeVal={(node) => Math.max(1, node.degree * 0.7)}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={paintPointerArea}
              autoPauseRedraw={false}
              linkColor={(link) => {
                const source = getNodeId(link.source);
                const target = getNodeId(link.target);
                if (!activePath) return isDark ? "rgba(214, 211, 209, 0.2)" : "rgba(89, 84, 78, 0.24)";
                return source === activePath || target === activePath
                  ? isDark
                    ? "rgba(250, 250, 249, 0.9)"
                    : "rgba(41, 37, 36, 0.88)"
                  : isDark
                    ? "rgba(214, 211, 209, 0.15)"
                    : "rgba(89, 84, 78, 0.18)";
              }}
              linkWidth={(link) => {
                const source = getNodeId(link.source);
                const target = getNodeId(link.target);
                return activePath && (source === activePath || target === activePath) ? 2 : 0.65;
              }}
              minZoom={0.35}
              maxZoom={8}
              warmupTicks={80}
              cooldownTicks={220}
              d3VelocityDecay={0.32}
              onNodeClick={(node) => setSelectedPath((path) => (path === node.id ? "" : String(node.id ?? "")))}
              onNodeHover={(node) => setHoveredPath(node?.id ? String(node.id) : "")}
              onBackgroundClick={() => setSelectedPath("")}
            />
          ) : null}
        </div>

        {!isLoading && !error && graphData.nodes.length > 0 ? (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border bg-background/80 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            <NetworkIcon className="size-3.5" />
            <span>拖拽节点整理图谱，滚轮缩放视图</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-card/80 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            正在构建图谱
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => setReloadToken((token) => token + 1)}>
              <RefreshCwIcon data-icon="inline-start" />
              重试
            </Button>
          </div>
        ) : null}
        {!isLoading && !error && graphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <NetworkIcon className="size-6" />
            <p className="text-sm">知识库中还没有 Markdown 笔记。</p>
          </div>
        ) : null}
      </section>

      {!selectedNode && graphData.nodes.length > 0 ? (
        <p className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <FileTextIcon className="size-3.5" />
          点击笔记查看详情。{isolatedCount > 0 ? `${isolatedCount} 篇未关联笔记位于图谱外围。` : ""}
        </p>
      ) : null}

      {selectedNode ? (
        <section className="flex shrink-0 flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FileTextIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium">{selectedNode.title}</h2>
              <p className="truncate font-mono text-xs text-muted-foreground">{selectedNode.path}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground sm:justify-end">
            <span>{selectedNode.folder || "根目录"}</span>
            <span>{formatFileSize(selectedNode.size)}</span>
            <span>{formatUpdatedAt(selectedNode.updated_at)}</span>
            <span>{selectedNode.degree} 个关联</span>
            <Button size="icon-xs" variant="ghost" aria-label="取消选择笔记" onClick={() => setSelectedPath("")}>
              <XIcon />
            </Button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
