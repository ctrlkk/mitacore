import { Focus } from "lucide-react";
import ForceGraph2D, { type ForceGraphMethods, type GraphData, type NodeObject } from "react-force-graph-2d";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type KnowledgeGraphNote = {
  path: string;
  title: string;
  folder: string;
  links: string[];
};

type GraphNode = KnowledgeGraphNote & { id: string; degree: number };
type GraphLink = { source: string; target: string };

function getNodeId(node: string | number | NodeObject<GraphNode> | undefined) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  return node?.id ?? "";
}

export function KnowledgeGraph({ notes, search }: { notes: KnowledgeGraphNote[]; search: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink>>(undefined);
  const autoFitDoneRef = useRef(false);
  const [size, setSize] = useState({ width: 900, height: 620 });
  const [hoveredPath, setHoveredPath] = useState("");
  const [selectedPath, setSelectedPath] = useState("");

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateSize = () => setSize({ width: container.clientWidth, height: Math.max(620, container.clientHeight) });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const visiblePaths = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return new Set(notes.map((note) => note.path));
    const matches = notes.filter((note) => `${note.path}\n${note.title}`.toLocaleLowerCase().includes(keyword));
    const paths = new Set(matches.map((note) => note.path));
    for (const note of notes) {
      if (paths.has(note.path)) note.links.forEach((path) => paths.add(path));
      if (note.links.some((path) => paths.has(path))) paths.add(note.path);
    }
    return paths;
  }, [notes, search]);

  const graphData = useMemo<GraphData<GraphNode, GraphLink>>(() => {
    const visibleNotes = notes.filter((note) => visiblePaths.has(note.path));
    const degrees = new Map(visibleNotes.map((note) => [note.path, 0]));
    const links = visibleNotes.flatMap((note) =>
      note.links.flatMap((target) => {
        if (!degrees.has(target) || target === note.path) return [];
        degrees.set(note.path, degrees.get(note.path)! + 1);
        degrees.set(target, degrees.get(target)! + 1);
        return [{ source: note.path, target }];
      }),
    );
    return {
      nodes: visibleNotes.map((note) => ({ ...note, id: note.path, degree: degrees.get(note.path)! })),
      links,
    };
  }, [notes, visiblePaths]);

  const hoveredPaths = useMemo(() => {
    const paths = new Set<string>();
    if (!hoveredPath) return paths;
    paths.add(hoveredPath);
    const hoveredNote = notes.find((note) => note.path === hoveredPath);
    hoveredNote?.links.forEach((path) => paths.add(path));
    notes.filter((note) => note.links.includes(hoveredPath)).forEach((note) => paths.add(note.path));
    return paths;
  }, [hoveredPath, notes]);

  const selectedPaths = useMemo(() => {
    const paths = new Set<string>();
    if (!selectedPath) return paths;
    paths.add(selectedPath);
    const selectedNote = notes.find((note) => note.path === selectedPath);
    selectedNote?.links.forEach((path) => paths.add(path));
    notes.filter((note) => note.links.includes(selectedPath)).forEach((note) => paths.add(note.path));
    return paths;
  }, [selectedPath, notes]);

  useEffect(() => {
    const graph = graphRef.current;
    autoFitDoneRef.current = false;
    const charge = graph?.d3Force("charge");
    if (charge && "strength" in charge && typeof charge.strength === "function") charge.strength(-180);
    const link = graph?.d3Force("link");
    if (link && "distance" in link && typeof link.distance === "function") link.distance(72);
    graph?.d3ReheatSimulation();
    const fitTimer = window.setTimeout(() => {
      graph?.zoomToFit(450, 56, (node) => (node as NodeObject<GraphNode>).degree > 0);
      autoFitDoneRef.current = true;
    }, 1_000);
    return () => window.clearTimeout(fitTimer);
  }, [graphData]);

  useEffect(() => {
    if (selectedPath && !visiblePaths.has(selectedPath)) setSelectedPath("");
  }, [selectedPath, visiblePaths]);

  const drawNode = (node: NodeObject<GraphNode>, context: CanvasRenderingContext2D, globalScale: number) => {
    if (node.x === undefined || node.y === undefined) return;
    const selected = node.id === selectedPath;
    const hovered = node.id === hoveredPath;
    const activePath = hoveredPath || selectedPath;
    const activePaths = hoveredPath ? hoveredPaths : selectedPaths;
    const isConnected = activePaths.has(node.id);
    const radius = Math.min(11, 3.5 + Math.sqrt(node.degree + 1) * 0.85);
    context.beginPath();
    context.arc(node.x, node.y, hovered || selected ? radius + 1.5 : radius, 0, Math.PI * 2);
    context.fillStyle = hovered || selected ? "#7962aa" : isConnected ? "#56524d" : "#8d8983";
    context.globalAlpha = hovered || selected ? 1 : 0.92;
    context.fill();
    context.globalAlpha = 1;
    if (hovered || selected) {
      context.lineWidth = 1.5 / globalScale;
      context.strokeStyle = hovered ? "#f4efff" : "#b9add2";
      context.stroke();
    }

    const showByScale =
      globalScale >= 1.45 ||
      (globalScale >= 1 && node.degree >= 2) ||
      (globalScale >= 0.72 && node.degree >= 6) ||
      node.degree >= 14;
    const showLabel = activePath ? isConnected || showByScale : showByScale;
    if (!showLabel) return;

    const label = node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title;
    const fontSize = (hovered || selected ? 12 : 10.5) / globalScale;
    context.globalAlpha = 1;
    context.font = `${hovered || selected ? 600 : 400} ${fontSize}px "Noto Sans SC", sans-serif`;
    context.fillStyle = hovered ? "#493568" : isConnected ? "#4f4b47" : selected ? "#624c88" : "#77736e";
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(label, node.x, node.y + radius + 3 / globalScale);
    context.globalAlpha = 1;
  };

  const paintPointerArea = (
    node: NodeObject<GraphNode>,
    color: string,
    context: CanvasRenderingContext2D,
    globalScale: number,
  ) => {
    if (node.x === undefined || node.y === undefined) return;
    context.beginPath();
    context.arc(node.x, node.y, Math.max(11, 12 / globalScale), 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  };

  return (
    <div
      ref={containerRef}
      className="relative h-[calc(100vh-220px)] min-h-[620px] overflow-hidden rounded-xl border border-[#dedbd5]"
      role="img"
      aria-label="知识库双链关系图"
      data-hovered-node={hoveredPath || undefined}
    >
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
          const activePath = hoveredPath || selectedPath;
          if (!activePath) return "rgba(89, 84, 78, 0.24)";
          return source === activePath || target === activePath ? "rgba(112, 84, 161, 0.9)" : "rgba(89, 84, 78, 0.24)";
        }}
        linkWidth={(link) => {
          const source = getNodeId(link.source);
          const target = getNodeId(link.target);
          const activePath = hoveredPath || selectedPath;
          if (!activePath) return 0.65;
          return source === activePath || target === activePath ? 2 : 0.65;
        }}
        minZoom={0.35}
        maxZoom={8}
        warmupTicks={80}
        cooldownTicks={220}
        d3VelocityDecay={0.32}
        onEngineStop={() => {
          if (autoFitDoneRef.current) return;
          graphRef.current?.zoomToFit(350, 56, (node) => (node as NodeObject<GraphNode>).degree > 0);
          autoFitDoneRef.current = true;
        }}
        onNodeClick={(node) => setSelectedPath((path) => (path === node.id ? "" : node.id))}
        onNodeHover={(node) => setHoveredPath(node?.id ?? "")}
      />
      <button
        className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-lg border border-[#dedbd5] bg-white/92 px-3 py-2 text-xs font-700 text-[#625e58] shadow-sm backdrop-blur hover:bg-[#faf9f6] hover:text-[#493568]"
        onClick={() => graphRef.current?.zoomToFit(350, 56, (node) => (node as NodeObject<GraphNode>).degree > 0)}
      >
        <Focus size={15} />
        适应视图
      </button>
      <div className="pointer-events-none absolute bottom-4 left-4 rounded-lg border border-[#e1ded8] bg-white/92 px-3 py-2 text-[11px] leading-5 text-[#77736e] shadow-sm backdrop-blur">
        点击节点锁定关系 · 悬浮预览关联 · 拖拽、缩放与平移
      </div>
    </div>
  );
}
