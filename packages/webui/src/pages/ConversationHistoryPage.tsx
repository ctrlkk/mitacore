import { useEffect, useState } from "react";
import { LoaderCircleIcon, RefreshCwIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import {
  collectToolParts,
  formatToolOutput,
  formatValue,
  messageParts,
  submitPlanReply,
  type HistoryRecord,
  type MessagePart,
} from "@/lib/planner-history";

type Round = {
  start: number;
  user_index: number;
  reply_start: number | null;
  can_rollback: boolean;
  reason?: string;
};

type HistoryResponse = { version: string; planner: HistoryRecord[]; reply: HistoryRecord[]; rounds: Round[] };

function getErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = data.error;
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : fallback;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function ContentText({ children }: { children: string }) {
  return (
    <pre className="max-h-96 max-w-full overflow-auto break-all font-sans text-sm whitespace-pre-wrap">{children}</pre>
  );
}

function TextMessage({
  text,
  role,
  timestamp,
  rollback,
  onRollback,
}: {
  text: string;
  role: "user" | "assistant";
  timestamp: number;
  rollback?: Round;
  onRollback: (round: Round) => void;
}) {
  const isUser = role === "user";
  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageContent>
        <MessageHeader>{isUser ? "用户输入" : "规划层"}</MessageHeader>
        <Bubble variant={isUser ? "secondary" : "ghost"} align={isUser ? "end" : "start"}>
          <BubbleContent>
            <ContentText>{text}</ContentText>
          </BubbleContent>
        </Bubble>
        <MessageFooter className="flex-wrap gap-2">
          {formatDate(timestamp)}
          {rollback ? (
            <Button size="xs" variant="ghost" disabled={!rollback.can_rollback} onClick={() => onRollback(rollback)}>
              <RotateCcwIcon data-icon="inline-start" />
              从此处回退
            </Button>
          ) : null}
          {rollback?.reason ? <span>{rollback.reason}</span> : null}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

function ToolCall({ call, result }: { call: MessagePart; result?: MessagePart }) {
  const isSubmit = call.toolName === "submit_plan";
  const plan = call.input && typeof call.input === "object" && "plan" in call.input ? call.input.plan : call.input;
  return (
    <Message>
      <MessageContent>
        <Card size="sm" className="w-full">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {isSubmit ? "发送回复" : "工具调用"}
              <Badge variant="outline">{call.toolName ?? "未知工具"}</Badge>
            </CardTitle>
            {isSubmit ? <CardDescription>规划层调用 reply agent，以下是实际返回的回复</CardDescription> : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {isSubmit ? (
              <Bubble variant="secondary" className="max-w-full">
                <BubbleContent className="w-full">
                  <ContentText>{result ? submitPlanReply(result.output) : "没有记录到回复结果"}</ContentText>
                </BubbleContent>
              </Bubble>
            ) : null}
            {isSubmit ? (
              <details className="min-w-0 text-sm text-muted-foreground">
                <summary className="cursor-pointer select-none">查看回复策略</summary>
                <ContentText>{formatValue(plan)}</ContentText>
              </details>
            ) : (
              <ContentText>{formatValue(call.input)}</ContentText>
            )}
          </CardContent>
        </Card>
      </MessageContent>
    </Message>
  );
}

function ToolResult({ result }: { result: MessagePart }) {
  return (
    <Message>
      <MessageContent>
        <Card size="sm" className="w-full">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              工具结果 <Badge variant="outline">{result.toolName ?? "未知工具"}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ContentText>
              {result.toolName === "submit_plan" ? submitPlanReply(result.output) : formatToolOutput(result.output)}
            </ContentText>
          </CardContent>
        </Card>
      </MessageContent>
    </Message>
  );
}

function PlannerTimeline({
  records,
  rounds,
  onRollback,
}: {
  records: HistoryRecord[];
  rounds: Round[];
  onRollback: (round: Round) => void;
}) {
  const { calls, results } = collectToolParts(records);
  const roundsByIndex = new Map(rounds.map((round) => [round.user_index, round]));
  if (records.length === 0) return <p className="text-sm text-muted-foreground">暂无规划层消息</p>;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {records.map((record, recordIndex) => {
        if (record.system_update) {
          return (
            <div key={recordIndex}>
              <Marker>
                <MarkerContent>系统上下文更新 · {formatDate(record.timestamp)}</MarkerContent>
              </Marker>
              <details className="mt-1 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">查看内容</summary>
                <ContentText>{formatValue(record.message.content)}</ContentText>
              </details>
            </div>
          );
        }
        const parts = messageParts(record.message.content);
        return (
          <div key={recordIndex} className="flex min-w-0 flex-col gap-4">
            {record.summary ? (
              <Marker variant="separator">
                <MarkerContent>压缩摘要</MarkerContent>
              </Marker>
            ) : null}
            {parts.map((part, partIndex) => {
              const key = `${recordIndex}-${partIndex}`;
              if (record.message.role === "tool" && part.type === "tool-result") {
                if (part.toolName === "submit_plan" && part.toolCallId && calls.has(part.toolCallId)) return null;
                return <ToolResult key={key} result={part} />;
              }
              if (part.type === "tool-call") {
                return (
                  <ToolCall
                    key={key}
                    call={part}
                    result={
                      part.toolName === "submit_plan" && part.toolCallId ? results.get(part.toolCallId) : undefined
                    }
                  />
                );
              }
              if (part.type === "reasoning") {
                return (
                  <details key={key} className="min-w-0 text-sm text-muted-foreground">
                    <summary className="cursor-pointer select-none">规划推理</summary>
                    <ContentText>{part.text ?? ""}</ContentText>
                  </details>
                );
              }
              if (part.type === "text" && part.text) {
                const role = record.message.role === "user" ? "user" : "assistant";
                return (
                  <TextMessage
                    key={key}
                    role={role}
                    text={part.text}
                    timestamp={record.timestamp}
                    rollback={partIndex === 0 ? roundsByIndex.get(recordIndex) : undefined}
                    onRollback={onRollback}
                  />
                );
              }
              return (
                <Message key={key}>
                  <MessageContent>
                    <MessageHeader>
                      {record.message.role} · {part.type}
                    </MessageHeader>
                    <Bubble variant="outline" className="max-w-full">
                      <BubbleContent>
                        <ContentText>{formatValue(part.output)}</ContentText>
                      </BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function ConversationHistoryPage() {
  const [history, setHistory] = useState<HistoryResponse>();
  const [rollbackRound, setRollbackRound] = useState<Round>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [action, setAction] = useState<"rollback" | "clear" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const response = await fetch("/api/conversation-history", { signal: controller.signal, cache: "no-store" });
        const data = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(getErrorMessage(data, "加载对话历史失败"));
        const next = data as HistoryResponse;
        if (controller.signal.aborted) return;
        setHistory(next);
        setError("");
      } catch (exception) {
        if (!controller.signal.aborted) setError(exception instanceof Error ? exception.message : "加载对话历史失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [refreshToken]);

  const removedPlanner = history && rollbackRound ? history.planner.length - rollbackRound.start : 0;
  const removedReply =
    history && rollbackRound
      ? history.reply.length -
        history.rounds
          .filter((round) => round.user_index >= rollbackRound.user_index && round.reply_start !== null)
          .map((round) => round.reply_start!)
          .reduce((earliest, start) => Math.min(earliest, start), history.reply.length)
      : 0;

  async function confirmAction() {
    if (!history || !action || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/conversation-history/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "rollback"
            ? { user_index: rollbackRound?.user_index, version: history.version }
            : { version: history.version },
        ),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(data, "修改历史失败"));
      toast.success(action === "clear" ? "双层对话历史已清空" : "已回退到该条用户消息之前");
      setRollbackRound(undefined);
    } catch (exception) {
      toast.error(exception instanceof Error ? exception.message : "修改历史失败");
    } finally {
      setAction(null);
      setBusy(false);
      setRefreshToken((value) => value + 1);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">对话历史</h1>
          <p className="text-sm text-muted-foreground">
            以规划层消息为主线预览对话，回退会同时截断规划层和回复层历史。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading || busy}
          >
            <RefreshCwIcon data-icon="inline-start" />
            刷新
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setRollbackRound(undefined);
              setAction("clear");
            }}
            disabled={!history || busy || (!history.planner.length && !history.reply.length)}
          >
            <Trash2Icon data-icon="inline-start" />
            清空历史
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading && !history ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          正在加载历史
        </p>
      ) : null}
      {history ? (
        <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            规划层 {history.planner.length} 条消息 · 回复层 {history.reply.length} 条记录
          </p>
          <div className="min-w-0 flex-1 rounded-xl border bg-card p-3 sm:p-5">
            <PlannerTimeline
              records={history.planner}
              rounds={history.rounds}
              onRollback={(round) => {
                if (busy) return;
                setRollbackRound(round);
                setAction("rollback");
              }}
            />
          </div>
        </div>
      ) : null}

      <AlertDialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{action === "clear" ? "清空双层对话历史？" : "从这条消息起回退历史？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {action === "clear"
                ? `将清空规划层 ${history?.planner.length ?? 0} 条、回复层 ${history?.reply.length ?? 0} 条记录。`
                : `将删除这条用户消息及之后的规划层 ${removedPlanner} 条、回复层 ${removedReply} 条记录。此操作不会撤回已发送给用户的消息。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void confirmAction()}>
              {busy ? "正在处理" : "确认"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
