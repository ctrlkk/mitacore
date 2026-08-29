import { useEffect, useState } from "react";
import { ImagePlusIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, StickerIcon, Trash2Icon } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StickerCreateDialog } from "@/components/stickers/StickerCreateDialog";

type Sticker = {
  name: string;
  filename: string;
  description: string;
  size: number;
  updated_at: number;
  url: string;
};

type StickersResponse = {
  stickers: Sticker[];
  summary: { total: number; limit: number };
};

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : fallback;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / 1024 ** (unit + 1)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(timestamp);
}

export function StickersPage() {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [summary, setSummary] = useState<StickersResponse["summary"]>({ total: 0, limit: 30 });
  const [refreshToken, setRefreshToken] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedSticker, setSelectedSticker] = useState<Sticker>();
  const [isStickerPreviewOpen, setIsStickerPreviewOpen] = useState(false);
  const [stickerToDelete, setStickerToDelete] = useState<Sticker>();
  const [isDeleting, setIsDeleting] = useState(false);
  const remaining = Math.max(summary.limit - summary.total, 0);
  const canCreate = remaining > 0;

  useEffect(() => {
    const controller = new AbortController();

    async function loadStickers() {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch("/api/stickers", { signal: controller.signal });
        const payload = (await response.json().catch(() => undefined)) as StickersResponse | undefined;
        if (!response.ok || !payload) throw new Error(getErrorMessage(payload, "读取贴纸库失败"));
        setStickers(payload.stickers);
        setSummary(payload.summary);
      } catch (exception) {
        if (!controller.signal.aborted) setError(exception instanceof Error ? exception.message : "读取贴纸库失败");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadStickers();
    return () => controller.abort();
  }, [refreshToken]);

  async function deleteSticker() {
    if (!stickerToDelete || isDeleting) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/stickers/${encodeURIComponent(stickerToDelete.name)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(payload, "删除贴纸失败"));
      setStickerToDelete(undefined);
      toast.success(`贴纸 [${stickerToDelete.name}] 已删除`);
      setRefreshToken((current) => current + 1);
    } catch (exception) {
      toast.error(exception instanceof Error ? exception.message : "删除贴纸失败");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">贴纸管理</h1>
          <p className="text-sm text-muted-foreground">维护代理可根据名称和场景描述调用的专属贴纸。</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshToken((current) => current + 1)}
            disabled={isLoading}
          >
            <RefreshCwIcon data-icon="inline-start" className={isLoading ? "animate-spin" : undefined} />
            刷新
          </Button>
          <Button size="sm" onClick={() => setIsCreateOpen(true)} disabled={!canCreate}>
            <PlusIcon data-icon="inline-start" />
            添加贴纸
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <StickerIcon className="size-4" />
            贴纸库
          </CardTitle>
          <CardDescription>每张贴纸都需要明确的名称与描述，帮助代理准确选择合适的表达。</CardDescription>
          <CardAction>
            <Badge variant={canCreate ? "secondary" : "destructive"}>
              {summary.total} / {summary.limit}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {isLoading ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              正在读取贴纸库
            </div>
          ) : stickers.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <StickerIcon className="size-8" />
              <p className="text-sm">贴纸库还是空的</p>
              {canCreate ? (
                <Button variant="outline" size="sm" onClick={() => setIsCreateOpen(true)}>
                  <ImagePlusIcon data-icon="inline-start" />
                  添加第一张贴纸
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {stickers.map((sticker) => (
                <StickerCard
                  key={sticker.name}
                  sticker={sticker}
                  onOpen={() => {
                    setSelectedSticker(sticker);
                    setIsStickerPreviewOpen(true);
                  }}
                  onDelete={() => setStickerToDelete(sticker)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <StickerCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onCreated={() => setRefreshToken((current) => current + 1)}
      />
      <StickerPreviewDialog
        open={isStickerPreviewOpen}
        sticker={selectedSticker}
        onClose={() => setIsStickerPreviewOpen(false)}
      />
      <AlertDialog open={Boolean(stickerToDelete)} onOpenChange={(open) => !open && setStickerToDelete(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除贴纸</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除贴纸 [{stickerToDelete?.name}] 吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isDeleting} onClick={() => void deleteSticker()}>
              {isDeleting ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              删除贴纸
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function StickerCard({ sticker, onOpen, onDelete }: { sticker: Sticker; onOpen: () => void; onDelete: () => void }) {
  return (
    <Card size="sm" className="min-w-0 gap-2 py-0">
      <button
        type="button"
        aria-label={`预览贴纸 [${sticker.name}]`}
        className="group relative block w-full overflow-hidden text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onOpen}
      >
        <img
          className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          src={sticker.url}
          alt={sticker.description || `[${sticker.name}]`}
          loading="lazy"
        />
      </button>
      <CardContent className="flex items-center gap-1 px-3 pb-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate text-sm">[{sticker.name}]</CardTitle>
          <CardDescription
            className="truncate text-xs"
            title={`${formatBytes(sticker.size)} · ${formatDate(sticker.updated_at)}`}
          >
            {formatBytes(sticker.size)} · {formatDate(sticker.updated_at)}
          </CardDescription>
          <p className="line-clamp-1 text-xs text-muted-foreground">{sticker.description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={`删除贴纸 [${sticker.name}]`}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </CardContent>
    </Card>
  );
}

function StickerPreviewDialog({ open, sticker, onClose }: { open: boolean; sticker?: Sticker; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>[{sticker?.name}]</DialogTitle>
          <DialogDescription>{sticker?.description}</DialogDescription>
        </DialogHeader>
        {sticker ? (
          <img
            className="aspect-square w-full rounded-lg border object-contain"
            src={sticker.url}
            alt={sticker.description || `[${sticker.name}]`}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
