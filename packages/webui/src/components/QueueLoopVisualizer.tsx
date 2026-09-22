import { useEffect, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  AtSignIcon,
  BotIcon,
  CheckIcon,
  Clock3Icon,
  InboxIcon,
  LoaderCircleIcon,
  MessageCircleMoreIcon,
  PlayIcon,
  PauseIcon,
  StepForwardIcon,
  GaugeIcon,
  RotateCcwIcon,
  ScanSearchIcon,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createLoopClock } from "./queue-loop-clock";

type LoopPhase = "idle" | "collecting" | "debouncing" | "evaluating" | "processing" | "complete";

type FlowPath = "idle" | "preprocess" | "waiting" | "resources" | "evaluate" | "process" | "return" | "complete";

type DemoMessage = {
  id: number;
  force: boolean;
  evaluated: boolean;
  preprocessed: boolean;
};

type LoopNodeData = Record<string, unknown> & {
  kind: "source" | "preprocess" | "queue" | "timer" | "decision" | "process";
  title: string;
  description: string;
  active: boolean;
  messages?: DemoMessage[];
  maxQueue?: number;
  debounceMs?: number;
  remainingMs?: number | null;
  countdownActive?: boolean;
  preprocessingCount?: number;
  preprocessingProgress?: number;
  cycle?: number;
  processingCount?: number;
  isDemoRunning?: boolean;
  paused?: boolean;
  processingProgress?: number;
};

type LoopNode = Node<LoopNodeData, "loop">;

type LoopEdgeData = Record<string, unknown> & {
  active: boolean;
  label: string;
  paused?: boolean;
  speed?: number;
};

type LoopEdge = Edge<LoopEdgeData, "loop">;

const nodeTypes = { loop: LoopFlowNode };
const edgeTypes = { loop: AnimatedFlowEdge };
// fitView 默认只计算节点边界，额外留白用于容纳外围回流线。
const flowFitOptions = { padding: 0.22, maxZoom: 1 };
const preprocessingDurationMin = 1600;
const preprocessingDurationRange = 801;
const evaluationDuration = 1200;
const processingDuration = 2800;
const returnPathDuration = 1400;
const completePathDuration = 1800;

const nodeIcons = {
  source: MessageCircleMoreIcon,
  preprocess: LoaderCircleIcon,
  queue: InboxIcon,
  timer: Clock3Icon,
  decision: ScanSearchIcon,
  process: BotIcon,
} as const;

function LoopFlowNode({ data }: NodeProps<LoopNode>) {
  const Icon = nodeIcons[data.kind];
  const messages = data.messages ?? [];
  const visibleMessages = messages.slice(-6);
  const hiddenMessageCount = messages.length - visibleMessages.length;
  const maxQueue = data.maxQueue ?? 1;
  const queueFill = Math.min(100, (messages.length / maxQueue) * 100);
  const debounceMs = data.debounceMs ?? 0;
  const remainingMs = data.remainingMs ?? debounceMs;
  const debounceProgress = data.countdownActive && debounceMs > 0 ? (remainingMs / debounceMs) * 100 : 0;

  return (
    <motion.div
      initial={false}
      animate={{ scale: data.active && !data.paused ? 1.015 : 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      className={cn(
        "relative w-72 rounded-xl border bg-card/95 shadow-sm backdrop-blur-sm transition-[border-color,box-shadow]",
        data.active && "border-primary/60 shadow-lg ring-4 ring-primary/8",
      )}
    >
      <Handle id="target-left" type="target" position={Position.Left} className="opacity-0" />
      <Handle id="target-top" type="target" position={Position.Top} className="opacity-0" />
      <Handle id="target-right" type="target" position={Position.Right} className="opacity-0" />
      <Handle id="target-bottom" type="target" position={Position.Bottom} className="opacity-0" />
      <Handle id="source-left" type="source" position={Position.Left} className="opacity-0" />
      <Handle id="source-top" type="source" position={Position.Top} className="opacity-0" />
      <Handle id="source-right" type="source" position={Position.Right} className="opacity-0" />
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="opacity-0" />

      <div className="flex items-start gap-3 p-3">
        <motion.span
          animate={data.active && !data.paused ? { scale: [1, 1.08, 1] } : { scale: 1 }}
          transition={{ duration: 1.4, repeat: data.active && !data.paused ? Infinity : 0 }}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
            data.active && "bg-primary text-primary-foreground",
          )}
        >
          <Icon
            className={cn(
              "size-4",
              !data.paused && data.kind === "preprocess" && data.preprocessingCount && "motion-safe:animate-spin",
            )}
          />
        </motion.span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{data.title}</h3>
            {data.kind === "queue" ? (
              <Badge variant={messages.length >= maxQueue ? "secondary" : "outline"}>
                {messages.length} / {maxQueue}
              </Badge>
            ) : data.kind === "preprocess" && data.preprocessingCount ? (
              <Badge variant="secondary">{data.preprocessingCount} 处理中</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{data.description}</p>
        </div>
      </div>

      {data.kind === "source" ? (
        <div className="flex items-center gap-2 border-t px-3 py-2.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" />
          处理期间也能接收新消息
        </div>
      ) : null}

      {data.kind === "queue" ? (
        <div className="border-t px-3 py-3">
          <div role="list" aria-label="待处理消息" className="flex min-h-9 flex-wrap content-center gap-1.5">
            <AnimatePresence initial={false} mode="popLayout">
              {visibleMessages.map((message) => (
                <motion.div
                  layout
                  key={message.id}
                  role="listitem"
                  initial={{ opacity: 0, scale: 0.7, x: -12 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.65, y: -14 }}
                  transition={{ type: "spring", stiffness: 520, damping: 32 }}
                  className={cn(
                    "flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-mono text-xs shadow-xs",
                    message.force && "border-primary/50 bg-primary/5",
                    message.evaluated && "border-dashed text-muted-foreground shadow-none",
                  )}
                >
                  {message.force ? <AtSignIcon className="size-3" /> : null}
                  <span>#{message.id}</span>
                  {message.evaluated ? (
                    <CheckIcon className="size-3" aria-label="已评估" />
                  ) : !message.preprocessed ? (
                    <LoaderCircleIcon
                      className={cn("size-3", !data.paused && "motion-safe:animate-spin")}
                      aria-label="资源准备中"
                    />
                  ) : (
                    <span className="size-1.5 rounded-full bg-primary" aria-label="资源已就绪" />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            {hiddenMessageCount > 0 ? (
              <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs">+{hiddenMessageCount}</span>
            ) : null}
            {messages.length === 0 && !data.processingCount ? (
              <span className="text-xs text-muted-foreground">等待消息</span>
            ) : null}
            {data.processingCount ? (
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <LoaderCircleIcon className={cn("size-3", !data.paused && "motion-safe:animate-spin")} />
                已取走 {data.processingCount} 条
              </span>
            ) : null}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <motion.div
              className="h-full bg-primary"
              initial={false}
              animate={{ width: `${queueFill}%` }}
              transition={{ type: "spring", stiffness: 300, damping: 32 }}
            />
          </div>
        </div>
      ) : null}

      {data.kind === "preprocess" ? (
        <div className="border-t px-3 py-2.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>下载 → 转述 → 缓存</span>
            <span>{data.preprocessingCount ? `${data.preprocessingCount} 条并行` : "资源就绪"}</span>
          </div>
          <div
            role="progressbar"
            aria-label="异步资源预处理进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((data.preprocessingCount ? (data.preprocessingProgress ?? 0) : 1) * 100)}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <motion.div
              className="h-full bg-primary"
              animate={{ width: `${(data.preprocessingCount ? (data.preprocessingProgress ?? 0) : 1) * 100}%` }}
              transition={{ duration: 0.08, ease: "linear" }}
            />
          </div>
        </div>
      ) : null}

      {data.kind === "decision" ? (
        <div className="flex flex-col gap-2 border-t p-3 text-xs">
          <div className="flex justify-between">
            <span>@ / 私聊</span>
            <span className="text-primary">触发</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>普通群聊</span>
            <span>不触发</span>
          </div>
        </div>
      ) : null}

      {data.kind === "process" ? (
        <div className="border-t p-3">
          <div className="mb-2 flex justify-between text-xs text-muted-foreground">
            <span>
              {data.processingCount
                ? (data.processingProgress ?? 0) < 0.3
                  ? "合并资源 · 构建 prompt"
                  : (data.processingProgress ?? 0) < 0.8
                    ? "代理执行中"
                    : "发送回复"
                : "串行消费 · 整批取走"}
            </span>
            <span>{data.processingCount ? `${data.processingCount} 条` : "等待唤醒"}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full bg-primary"
              animate={{ width: `${(data.processingProgress ?? 0) * 100}%` }}
              transition={{ duration: 0.08 }}
            />
          </div>
        </div>
      ) : null}

      {data.kind === "timer" ? (
        <div className="border-t px-3 py-3">
          <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-xs">
            <span>{data.countdownActive ? "剩余时间" : "等待新消息"}</span>
            <span>{(remainingMs / 1000).toFixed(1)}s</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <motion.div
              key={data.cycle}
              initial={false}
              animate={{ width: `${debounceProgress}%` }}
              transition={{ duration: 0.08, ease: "linear" }}
              className="h-full bg-primary"
            />
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}

function AnimatedFlowEdge({
  id,
  data,
  markerEnd,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
}: EdgeProps<LoopEdge>) {
  const reducedMotion = useReducedMotion();
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 18,
    offset: id === "return" || id === "complete" ? 65 : 20,
  });
  const isActive = Boolean(data?.active);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: isActive ? "var(--primary)" : "var(--muted-foreground)",
          strokeOpacity: isActive ? 1 : 0.25,
          strokeDasharray: id === "return" || id === "complete" ? "5 5" : undefined,
          strokeWidth: isActive ? 2.5 : 1.5,
          transition: "stroke 180ms ease, stroke-width 180ms ease",
        }}
      />
      {isActive && !data?.paused && !reducedMotion
        ? [0, 1, 2].map((packet) => (
            <circle
              key={packet}
              r={packet === 0 ? 4 : 2.5}
              fill="var(--primary)"
              opacity={1 - packet * 0.25}
              className="queue-loop-flow-packet"
            >
              <animateMotion
                dur={`${1.8 / (data?.speed ?? 1)}s`}
                begin={`${-packet * 0.18}s`}
                repeatCount="indefinite"
                path={edgePath}
              />
            </circle>
          ))
        : null}
      <EdgeLabelRenderer>
        <span
          className={cn(
            "pointer-events-none absolute rounded-full bg-background/75 px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground",
            isActive && "border border-primary/30 bg-background/95 px-2 text-foreground shadow-sm",
          )}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {data?.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

function createFlowNodes({
  path,
  messages,
  maxQueue,
  debounceMs,
  remainingMs,
  countdownActive,
  preprocessingCount,
  preprocessingProgress,
  cycle,
  processingCount,
  isDemoRunning,
  compact,
  paused,
  processingProgress,
}: {
  path: FlowPath;
  messages: DemoMessage[];
  maxQueue: number;
  debounceMs: number;
  remainingMs: number | null;
  countdownActive: boolean;
  preprocessingCount: number;
  preprocessingProgress: number;
  cycle: number;
  processingCount: number;
  isDemoRunning: boolean;
  compact: boolean;
  paused: boolean;
  processingProgress: number;
}): LoopNode[] {
  const positions = compact
    ? {
        source: { x: 0, y: 0 },
        queue: { x: 0, y: 195 },
        timer: { x: 0, y: 425 },
        preprocess: { x: 0, y: 625 },
        decision: { x: 0, y: 825 },
        process: { x: 0, y: 1080 },
      }
    : {
        source: { x: 0, y: 0 },
        queue: { x: 400, y: 0 },
        preprocess: { x: 800, y: 0 },
        timer: { x: 400, y: 280 },
        decision: { x: 800, y: 280 },
        process: { x: 0, y: 280 },
      };

  return [
    {
      id: "source",
      type: "loop",
      position: positions.source,
      style: { pointerEvents: "all" },
      data: {
        kind: "source",
        title: "消息到达",
        description: "普通群聊、@ 或私聊事件",
        active: path === "preprocess",
        isDemoRunning,
        paused,
      },
    },
    {
      id: "queue",
      type: "loop",
      position: positions.queue,
      data: {
        kind: "queue",
        title: "会话队列",
        description: "按到达顺序保留，超限淘汰最早消息",
        active: path === "preprocess" || path === "waiting" || path === "return" || path === "complete",
        messages,
        paused,
        maxQueue,
        processingCount,
      },
    },
    {
      id: "preprocess",
      type: "loop",
      position: positions.preprocess,
      data: {
        kind: "preprocess",
        title: "异步资源预处理",
        description: "入队即启动，与静默窗口并行执行",
        active: path === "resources" || preprocessingCount > 0,
        preprocessingCount,
        preprocessingProgress,
        paused,
      },
    },
    {
      id: "timer",
      type: "loop",
      position: positions.timer,
      data: {
        kind: "timer",
        title: "静默窗口",
        description: "每次入队都会重新开始计时",
        active: path === "waiting",
        debounceMs,
        remainingMs,
        countdownActive,
        cycle,
        paused,
      },
    },
    {
      id: "decision",
      type: "loop",
      position: positions.decision,
      data: {
        kind: "decision",
        title: "触发判断",
        description: "根据消息类型判断是否唤醒代理",
        active: path === "evaluate" || path === "return",
        paused,
      },
    },
    {
      id: "process",
      type: "loop",
      position: positions.process,
      data: {
        kind: "process",
        title: "代理处理",
        description: processingCount ? `正在构建包含 ${processingCount} 条消息的 prompt` : "取走整批消息并调用代理",
        active: processingCount > 0 || path === "process" || path === "complete",
        processingCount,
        processingProgress,
        paused,
      },
    },
  ];
}

function createFlowEdges(
  activePath: FlowPath,
  compact: boolean,
  preprocessingCount: number,
  paused: boolean,
  speed: number,
): LoopEdge[] {
  const markerEnd = { type: MarkerType.ArrowClosed, width: 16, height: 16 };

  const edges: LoopEdge[] = [
    {
      id: "ingress",
      source: "source",
      target: "queue",
      sourceHandle: compact ? "source-bottom" : "source-right",
      targetHandle: compact ? "target-top" : "target-left",
      type: "loop",
      markerEnd,
      data: { active: activePath === "preprocess", label: "立即入队" },
    },
    {
      id: "waiting",
      source: "queue",
      target: "timer",
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
      type: "loop",
      markerEnd,
      data: { active: activePath === "waiting", label: "重置计时" },
    },
    {
      id: "resources",
      source: "queue",
      target: "preprocess",
      sourceHandle: "source-right",
      targetHandle: compact ? "target-right" : "target-left",
      type: "loop",
      markerEnd,
      data: { active: preprocessingCount > 0, label: "并行预处理" },
    },
    {
      id: "silence",
      source: "timer",
      target: "decision",
      sourceHandle: compact ? "source-left" : "source-right",
      targetHandle: "target-left",
      type: "loop",
      markerEnd,
      data: { active: activePath === "resources" || activePath === "evaluate", label: "静默结束" },
    },
    {
      id: "evaluate",
      source: "preprocess",
      target: "decision",
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
      type: "loop",
      markerEnd,
      data: {
        active: activePath === "resources" || activePath === "evaluate",
        label: activePath === "resources" ? "等待资源…" : "资源就绪",
      },
    },
    {
      id: "process",
      source: "decision",
      target: "process",
      sourceHandle: "source-bottom",
      targetHandle: compact ? "target-top" : "target-bottom",
      type: "loop",
      markerEnd,
      data: { active: activePath === "process", label: "满足触发" },
    },
    {
      id: "return",
      source: "decision",
      target: "queue",
      sourceHandle: "source-right",
      targetHandle: compact ? "target-right" : "target-bottom",
      type: "loop",
      markerEnd,
      data: { active: activePath === "return", label: "未触发 · 保留消息" },
    },
    {
      id: "complete",
      source: "process",
      target: "queue",
      sourceHandle: compact ? "source-left" : "source-right",
      targetHandle: "target-left",
      type: "loop",
      markerEnd,
      data: { active: activePath === "complete", label: "等待下一批" },
    },
  ];
  return edges.map((edge) => ({ ...edge, data: { ...edge.data!, paused, speed } }));
}

export function QueueLoopVisualizer({ maxQueue, debounceMs }: { maxQueue: number; debounceMs: number }) {
  const [clock] = useState(createLoopClock);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [compact, setCompact] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<LoopNode, LoopEdge> | null>(null);
  const [processingProgress, setProcessingProgress] = useState(0);
  const processingProgressTimerRef = useRef<number | undefined>(undefined);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [phase, setPhase] = useState<LoopPhase>("idle");
  const [path, setPath] = useState<FlowPath>("idle");
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [cycle, setCycle] = useState(0);
  const [discarded, setDiscarded] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [preprocessingCount, setPreprocessingCount] = useState(0);
  const [preprocessingProgress, setPreprocessingProgress] = useState(0);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const messagesRef = useRef<DemoMessage[]>([]);
  const processingCountRef = useRef(0);
  const pendingTriggerRef = useRef(false);
  const nextMessageIdRef = useRef(1);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const countdownIntervalRef = useRef<number | undefined>(undefined);
  const evaluationTimerRef = useRef<number | undefined>(undefined);
  const processingTimerRef = useRef<number | undefined>(undefined);
  const processingPathTimerRef = useRef<number | undefined>(undefined);
  const pathTimerRef = useRef<number | undefined>(undefined);
  const preprocessTimerRefs = useRef<number[]>([]);
  const preprocessProgressTimerRef = useRef<number | undefined>(undefined);
  const preprocessDurationsRef = useRef(new Set<number>());
  const preprocessTasksRef = useRef(new Map<number, { startedAt: number; duration: number }>());
  const demoTimerRefs = useRef<number[]>([]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => clock.advance(50 * speed), 50);
    return () => window.clearInterval(timer);
  }, [clock, paused, speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.width < 720);
      void flow?.fitView(flowFitOptions);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [flow]);

  useEffect(() => {
    const timer = window.setTimeout(() => void flow?.fitView(flowFitOptions), 100);
    return () => window.clearTimeout(timer);
  }, [compact, flow]);

  useEffect(() => {
    const current = messagesRef.current;
    if (current.length <= maxQueue) return;

    const overflow = current.length - maxQueue;
    const next = current.slice(overflow);
    messagesRef.current = next;
    setMessages(next);
    setDiscarded((value) => value + overflow);
  }, [maxQueue]);

  useEffect(
    () => () => {
      clock.clear();
    },
    [clock],
  );

  const nodes = createFlowNodes({
    path,
    messages,
    maxQueue,
    debounceMs,
    remainingMs,
    countdownActive: phase === "debouncing",
    preprocessingCount,
    preprocessingProgress,
    cycle,
    processingCount,
    isDemoRunning,
    compact,
    paused,
    processingProgress,
  });
  const edges = createFlowEdges(path, compact, preprocessingCount, paused, speed);

  function commitMessages(next: DemoMessage[]) {
    messagesRef.current = next;
    setMessages(next);
  }

  function clearCycleTimers() {
    clock.clearTimeout(debounceTimerRef.current);
    clock.clearInterval(countdownIntervalRef.current);
    clock.clearTimeout(evaluationTimerRef.current);
    clock.clearTimeout(pathTimerRef.current);
  }

  function updatePreprocessingProgress() {
    const tasks = [...preprocessTasksRef.current.values()];
    if (tasks.length === 0) {
      clock.clearInterval(preprocessProgressTimerRef.current);
      preprocessProgressTimerRef.current = undefined;
      setPreprocessingProgress(1);
      return;
    }

    setPreprocessingProgress(
      Math.min(...tasks.map((task) => Math.min(1, (clock.now() - task.startedAt) / task.duration))),
    );
  }

  function startProcessing(batchSize: number) {
    processingCountRef.current = batchSize;
    setProcessingCount(batchSize);
    setPhase("processing");
    setPath("process");
    const startedAt = clock.now();
    setProcessingProgress(0);
    processingProgressTimerRef.current = clock.setInterval(
      () => setProcessingProgress(Math.min(1, (clock.now() - startedAt) / processingDuration)),
      50,
    );
    processingTimerRef.current = clock.setTimeout(() => {
      clock.clearInterval(processingProgressTimerRef.current);
      setProcessingProgress(1);
      setProcessed((value) => value + batchSize);
      processingCountRef.current = 0;
      setProcessingCount(0);

      const queued = messagesRef.current;
      if (pendingTriggerRef.current && queued.length > 0) {
        pendingTriggerRef.current = false;
        clearCycleTimers();
        setRemainingMs(0);
        commitMessages([]);
        startProcessing(queued.length);
        return;
      }

      pendingTriggerRef.current = false;
      setPhase((current) => (current === "processing" ? "complete" : current));
      setPath((current) => (current === "process" ? "complete" : current));
      setIsDemoRunning(false);
      processingPathTimerRef.current = clock.setTimeout(() => {
        setPhase((current) => (current === "complete" ? "idle" : current));
        setPath((current) => (current === "complete" ? "idle" : current));
      }, completePathDuration);
    }, processingDuration);
  }

  function evaluateQueue() {
    clock.clearInterval(countdownIntervalRef.current);
    setRemainingMs(0);
    setPhase("evaluating");
    let decisionDelayStarted = false;

    function continueEvaluation() {
      const latest = messagesRef.current;
      const latestUnprocessed = latest.filter((message) => !message.evaluated);
      const latestHasForceTrigger = latestUnprocessed.some((message) => message.force);
      const shouldWaitForResources = latestHasForceTrigger || latestUnprocessed.length >= 5;
      const pendingResources = latestUnprocessed.filter((message) => !message.preprocessed).length;

      if (shouldWaitForResources && pendingResources > 0) {
        setPath("resources");
        evaluationTimerRef.current = clock.setTimeout(continueEvaluation, 50);
        return;
      }

      if (!decisionDelayStarted) {
        decisionDelayStarted = true;
        setPath("evaluate");
        evaluationTimerRef.current = clock.setTimeout(continueEvaluation, evaluationDuration);
        return;
      }

      if (latestUnprocessed.length === 0 || (!latestHasForceTrigger && latestUnprocessed.length < 5)) {
        setPhase("collecting");
        setPath("return");
        setIsDemoRunning(false);
        pathTimerRef.current = clock.setTimeout(() => setPath("idle"), returnPathDuration);
        return;
      }

      if (!latestHasForceTrigger) {
        commitMessages(
          latest.map((message) => (latestUnprocessed.includes(message) ? { ...message, evaluated: true } : message)),
        );
        setPhase("collecting");
        setPath("return");
        setIsDemoRunning(false);
        pathTimerRef.current = clock.setTimeout(() => setPath("idle"), returnPathDuration);
        return;
      }

      if (processingCountRef.current > 0) {
        commitMessages(
          latest.map((message) => (latestUnprocessed.includes(message) ? { ...message, evaluated: true } : message)),
        );
        pendingTriggerRef.current = true;
        setPhase("collecting");
        setPath("return");
        setIsDemoRunning(false);
        return;
      }

      const batchSize = latest.length;
      commitMessages([]);
      startProcessing(batchSize);
    }

    continueEvaluation();
  }

  function addMessage(force: boolean) {
    clearCycleTimers();

    let preprocessDuration = preprocessingDurationMin + Math.floor(Math.random() * preprocessingDurationRange);
    while (preprocessDurationsRef.current.has(preprocessDuration)) preprocessDuration += 1;
    preprocessDurationsRef.current.add(preprocessDuration);
    const message: DemoMessage = { id: nextMessageIdRef.current++, force, evaluated: false, preprocessed: false };
    preprocessTasksRef.current.set(message.id, { startedAt: clock.now(), duration: preprocessDuration });
    updatePreprocessingProgress();
    preprocessProgressTimerRef.current ??= clock.setInterval(updatePreprocessingProgress, 50);
    setPreprocessingCount((value) => value + 1);
    preprocessTimerRefs.current.push(
      clock.setTimeout(() => {
        preprocessDurationsRef.current.delete(preprocessDuration);
        preprocessTasksRef.current.delete(message.id);
        updatePreprocessingProgress();
        const nextMessages = messagesRef.current.map((queuedMessage) =>
          queuedMessage.id === message.id ? { ...queuedMessage, preprocessed: true } : queuedMessage,
        );
        commitMessages(nextMessages);
        setPreprocessingCount((value) => Math.max(0, value - 1));
      }, preprocessDuration),
    );
    let next = [...messagesRef.current, message];
    if (next.length > maxQueue) {
      const overflow = next.length - maxQueue;
      next = next.slice(overflow);
      setDiscarded((value) => value + overflow);
    }
    commitMessages(next);
    setPhase("debouncing");
    setPath("preprocess");
    setCycle((value) => value + 1);
    const countdownEndsAt = clock.now() + debounceMs;
    setRemainingMs(debounceMs);
    countdownIntervalRef.current = clock.setInterval(() => {
      const nextRemainingMs = Math.max(0, countdownEndsAt - clock.now());
      setRemainingMs(nextRemainingMs);
      if (nextRemainingMs === 0) clock.clearInterval(countdownIntervalRef.current);
    }, 50);
    pathTimerRef.current = clock.setTimeout(() => setPath("waiting"), Math.min(700, debounceMs / 2));
    debounceTimerRef.current = clock.setTimeout(evaluateQueue, debounceMs);
  }

  function resetVisualizer() {
    clearCycleTimers();
    clock.reset();
    preprocessTimerRefs.current = [];
    preprocessProgressTimerRef.current = undefined;
    preprocessDurationsRef.current.clear();
    preprocessTasksRef.current.clear();
    demoTimerRefs.current = [];
    commitMessages([]);
    processingCountRef.current = 0;
    pendingTriggerRef.current = false;
    setPhase("idle");
    setPath("idle");
    setRemainingMs(null);
    setDiscarded(0);
    setProcessed(0);
    setProcessingCount(0);
    setProcessingProgress(0);
    setPreprocessingCount(0);
    setPreprocessingProgress(0);
    setIsDemoRunning(false);
    setPaused(false);
    nextMessageIdRef.current = 1;
  }

  function runDemo() {
    resetVisualizer();
    setIsDemoRunning(true);
    const count = 3;
    const gap = Math.min(700, Math.max(50, debounceMs / 3));
    demoTimerRefs.current = Array.from({ length: count }, (_, index) =>
      clock.setTimeout(() => addMessage(index === count - 1), 100 + index * gap),
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <Card className="overflow-hidden py-0">
        <CardContent className="flex flex-col gap-0 px-0">
          <div className="flex flex-wrap items-center gap-2 border-b p-4">
            <Button onClick={runDemo}>
              <PlayIcon data-icon="inline-start" />
              完整演示
            </Button>
            <Button variant="secondary" onClick={() => addMessage(false)}>
              <MessageCircleMoreIcon data-icon="inline-start" />
              普通消息
            </Button>
            <Button variant="secondary" onClick={() => addMessage(true)}>
              <AtSignIcon data-icon="inline-start" />@ / 私聊消息
            </Button>
            <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
              <Button variant="ghost" onClick={() => setPaused(!paused)} aria-pressed={paused}>
                {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
                {paused ? "继续" : "暂停"}
              </Button>
              <Button
                variant="ghost"
                disabled={!paused}
                onClick={() => clock.advance(250)}
                title="暂停时推进 0.25 秒"
              >
                <StepForwardIcon data-icon="inline-start" />
                单步
              </Button>
              <Button
                variant="ghost"
                onClick={() => setSpeed(speed === 0.5 ? 1 : speed === 1 ? 2 : 0.5)}
                aria-label={`播放速度 ${speed} 倍，点击切换`}
              >
                <GaugeIcon data-icon="inline-start" />
                {speed}×
              </Button>
              <Button variant="ghost" onClick={resetVisualizer}>
                <RotateCcwIcon data-icon="inline-start" />
                重置
              </Button>
            </div>
          </div>
          <section role="region" aria-label="会话队列" className="sr-only">
            <span>
              {messages.length} / {maxQueue}
            </span>
            <span aria-label="异步预处理消息数">{preprocessingCount}</span>
            <ul>
              {messages.map((message) => (
                <li key={message.id}>{message.force ? "硬触发消息" : `消息 ${message.id}`}</li>
              ))}
            </ul>
            <div
              role="progressbar"
              aria-label="静默等待进度"
              aria-valuemin={0}
              aria-valuemax={debounceMs}
              aria-valuenow={phase === "debouncing" ? Math.round(remainingMs ?? debounceMs) : 0}
              aria-valuetext={
                phase === "debouncing" ? `剩余 ${((remainingMs ?? debounceMs) / 1000).toFixed(1)} 秒` : "未计时"
              }
            />
          </section>

          <div className="grid grid-cols-2 border-b sm:grid-cols-4" aria-label="消息循环指标">
            <Metric label="队列" value={`${messages.length} / ${maxQueue}`} />
            <Metric label="静默窗口" value={`${(debounceMs / 1000).toFixed(1)}s`} />
            <Metric label="已处理" value={String(processed)} />
            <Metric label="已淘汰" value={String(discarded)} destructive={discarded > 0} valueLabel="已淘汰消息数" />
          </div>

          <div
            ref={canvasRef}
            className={cn("relative overflow-hidden bg-muted/20", compact ? "h-280" : "h-112")}
            aria-label="消息循环流程画布"
          >
            <ReactFlow
              onInit={setFlow}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={flowFitOptions}
              minZoom={0.2}
              maxZoom={1.8}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnScroll={false}
              zoomOnScroll={false}
              zoomOnPinch
              preventScrolling={false}
              proOptions={{ hideAttribution: true }}
              className="queue-loop-flow"
              aria-label="消息循环交互流程图，可拖动平移或使用右下角按钮缩放"
            >
              <Background gap={24} size={1} color="var(--border)" />
              <Controls showInteractive={false} position="bottom-right" fitViewOptions={flowFitOptions} />
            </ReactFlow>
            <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm">
              <span
                className={cn(
                  "size-2 rounded-full bg-muted-foreground",
                  path !== "idle" && !paused && "motion-safe:animate-pulse bg-primary",
                )}
              />
              {paused
                ? "已暂停 · 可单步推进"
                : isDemoRunning
                  ? "场景演示中"
                  : path === "idle"
                    ? "等待操作"
                    : "循环运行中"}
            </div>
          </div>

          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-3 py-2 text-xs text-muted-foreground"
            aria-label="读图指南"
          >
            <span className="flex items-center gap-2">
              <span className="w-5 border-t border-current" aria-hidden="true" />
              数据与就绪信号
            </span>
            <span className="flex items-center gap-2">
              <span className="w-5 border-t border-dashed border-current" aria-hidden="true" />
              保留消息 / 回到等待
            </span>
            <span className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
              当前活跃路径
            </span>
            <span className="sm:ml-auto">拖动平移 · 右下角缩放与适应画布</span>
          </div>

        </CardContent>
      </Card>
    </MotionConfig>
  );
}

function Metric({
  label,
  value,
  destructive = false,
  valueLabel,
}: {
  label: string;
  value: string;
  destructive?: boolean;
  valueLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-r px-3 py-2 last:border-r-0 even:border-r-0 sm:even:border-r sm:last:border-r-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <motion.p
        key={value}
        aria-label={valueLabel}
        initial={{ opacity: 0.4, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn("shrink-0 font-mono text-sm font-medium", destructive && "text-destructive")}
      >
        {value}
      </motion.p>
    </div>
  );
}
