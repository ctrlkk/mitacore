import { useDeferredValue, useEffect, useState } from "react";
import { AudioLinesIcon, FileImageIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type MediaKind = "image" | "video" | "audio";
type SortOrder = "newest" | "oldest" | "largest" | "smallest";

type CachedMedia = {
  filename: string;
  kind: MediaKind;
  path: string;
  description: string;
  size: number;
  updated_at: number;
  url: string;
};

type MediaResponse = {
  media: CachedMedia[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  summary: { total: number; total_size: number };
};

const PAGE_SIZE = 24;

const mediaLabels: Record<MediaKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
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
  const units = ["KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / 1024 ** (unit + 1)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function MediaCachePage() {
  const [media, setMedia] = useState<CachedMedia[]>([]);
  const [pagination, setPagination] = useState<MediaResponse["pagination"]>({
    page: 1,
    page_size: PAGE_SIZE,
    total: 0,
    total_pages: 1,
  });
  const [summary, setSummary] = useState<MediaResponse["summary"]>({ total: 0, total_size: 0 });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOrder>("newest");
  const [refreshToken, setRefreshToken] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedMedia, setSelectedMedia] = useState<CachedMedia>();
  const [description, setDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [mediaToDelete, setMediaToDelete] = useState<CachedMedia>();
  const [isDeleting, setIsDeleting] = useState(false);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    const controller = new AbortController();

    async function loadMedia() {
      setIsLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({
          page: String(pagination.page),
          page_size: String(PAGE_SIZE),
          search: deferredSearch,
          sort,
        });
        const response = await fetch(`/api/media?${query}`, { signal: controller.signal });
        const payload = (await response.json().catch(() => undefined)) as MediaResponse | undefined;
        if (!response.ok || !payload) throw new Error(getErrorMessage(payload, "读取媒体缓存失败"));
        setMedia(payload.media);
        setPagination(payload.pagination);
        setSummary(payload.summary);
      } catch (exception) {
        if (!controller.signal.aborted) {
          setError(exception instanceof Error ? exception.message : "读取媒体缓存失败");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadMedia();
    return () => controller.abort();
  }, [deferredSearch, pagination.page, refreshToken, sort]);

  function updateSearch(value: string) {
    setSearch(value);
    setPagination((current) => ({ ...current, page: 1 }));
  }

  function updateSort(value: string) {
    setSort(value as SortOrder);
    setPagination((current) => ({ ...current, page: 1 }));
  }

  function openEditor(item: CachedMedia) {
    setSelectedMedia(item);
    setDescription(item.description);
  }

  async function saveDescription() {
    if (!selectedMedia || isSaving) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(selectedMedia.filename)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(payload, "保存媒体描述失败"));
      setMedia((current) =>
        current.map((item) => (item.filename === selectedMedia.filename ? { ...item, description } : item)),
      );
      setSelectedMedia((current) => (current ? { ...current, description } : current));
      toast.success("媒体描述已保存");
    } catch (exception) {
      toast.error(exception instanceof Error ? exception.message : "保存媒体描述失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteMedia() {
    if (!mediaToDelete || isDeleting) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(mediaToDelete.filename)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(payload, "删除媒体缓存失败"));
      setMediaToDelete(undefined);
      setSelectedMedia((current) => (current?.filename === mediaToDelete.filename ? undefined : current));
      toast.success("媒体缓存已删除");
      setRefreshToken((current) => current + 1);
    } catch (exception) {
      toast.error(exception instanceof Error ? exception.message : "删除媒体缓存失败");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">媒体缓存</h1>
          <p className="text-sm text-muted-foreground">查看已下载的媒体资源，并维护供代理复用的转述内容。</p>
        </div>
        <Button variant="outline" onClick={() => setRefreshToken((current) => current + 1)} disabled={isLoading}>
          <RefreshCwIcon data-icon="inline-start" className={isLoading ? "animate-spin" : undefined} />
          刷新列表
        </Button>
      </div>

      <div className="flex flex-wrap items-center rounded-xl border bg-muted/30 px-4 py-3 text-sm">
        <span className="mr-4 text-muted-foreground">缓存概览</span>
        <div className="flex items-center gap-2 pr-4 sm:border-r">
          <FileImageIcon className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">文件</span>
          <strong className="font-semibold tabular-nums">{summary.total}</strong>
        </div>
        <div className="flex items-center gap-2 py-1 sm:border-r sm:px-4 sm:py-0">
          <span className="text-muted-foreground">占用空间</span>
          <strong className="font-semibold tabular-nums">{formatBytes(summary.total_size)}</strong>
        </div>
        <div className="flex items-center gap-2 py-1 sm:pl-4 sm:py-0">
          <span className="text-muted-foreground">{search ? "匹配结果" : "当前结果"}</span>
          <strong className="font-semibold tabular-nums">{pagination.total}</strong>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>缓存目录</CardTitle>
          <CardDescription>支持按文件名或转述内容搜索，点击卡片可查看完整媒体。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <InputGroup className="sm:max-w-md">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="搜索媒体缓存"
                value={search}
                placeholder="搜索文件名或媒体描述"
                onChange={(event) => updateSearch(event.target.value)}
              />
            </InputGroup>
            <Select value={sort} onValueChange={updateSort}>
              <SelectTrigger aria-label="排序方式" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="newest">最近更新</SelectItem>
                  <SelectItem value="oldest">最早更新</SelectItem>
                  <SelectItem value="largest">文件最大</SelectItem>
                  <SelectItem value="smallest">文件最小</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {isLoading ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              正在读取媒体缓存
            </div>
          ) : media.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <FileImageIcon className="size-8" />
              <p className="text-sm">{search ? "没有匹配的媒体资源" : "媒体缓存还是空的"}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {media.map((item) => (
                <MediaCard
                  key={item.filename}
                  media={item}
                  onOpen={() => openEditor(item)}
                  onDelete={() => setMediaToDelete(item)}
                />
              ))}
            </div>
          )}
        </CardContent>
        {pagination.total_pages > 1 ? (
          <CardFooter className="justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 项
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page <= 1 || isLoading}
                onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page >= pagination.total_pages || isLoading}
                onClick={() => setPagination((current) => ({ ...current, page: current.page + 1 }))}
              >
                下一页
              </Button>
            </div>
          </CardFooter>
        ) : null}
      </Card>

      <MediaDialog
        media={selectedMedia}
        description={description}
        isSaving={isSaving}
        onDescriptionChange={setDescription}
        onClose={() => setSelectedMedia(undefined)}
        onSave={() => void saveDescription()}
        onDelete={() => selectedMedia && setMediaToDelete(selectedMedia)}
      />
      <AlertDialog open={Boolean(mediaToDelete)} onOpenChange={(open) => !open && setMediaToDelete(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除媒体缓存</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除“{mediaToDelete?.filename}”及其媒体描述。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isDeleting} onClick={() => void deleteMedia()}>
              {isDeleting ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              删除缓存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function MediaCard({ media, onOpen, onDelete }: { media: CachedMedia; onOpen: () => void; onDelete: () => void }) {
  return (
    <Card size="sm" className="min-w-0 gap-2 py-0">
      <button
        type="button"
        aria-label="查看详情"
        className="group block w-full overflow-hidden text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onOpen}
      >
        <MediaPreview media={media} />
      </button>
      <CardContent className="flex items-start gap-1 px-3 pb-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate font-mono text-xs" title={media.filename}>
            {media.filename}
          </CardTitle>
          <CardDescription className="flex items-center gap-1 text-xs">
            <Badge variant="secondary">{mediaLabels[media.kind]}</Badge>
            <span>{formatBytes(media.size)}</span>
          </CardDescription>
          <p className="line-clamp-1 text-xs text-muted-foreground">{media.description || "尚未生成媒体转述"}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={`删除 ${media.filename}`}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </CardContent>
    </Card>
  );
}

function MediaPreview({ media, controls = false }: { media: CachedMedia; controls?: boolean }) {
  if (media.kind === "image") {
    return (
      <img
        className="aspect-video w-full object-cover"
        src={media.url}
        alt={media.description || media.filename}
        loading="lazy"
      />
    );
  }

  if (media.kind === "video") {
    return (
      <video
        className="aspect-video w-full bg-muted object-contain"
        src={media.url}
        controls={controls}
        preload="metadata"
      />
    );
  }

  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-3 bg-muted px-4 text-muted-foreground">
      <AudioLinesIcon className="size-9" />
      {controls ? (
        <audio className="w-full" src={media.url} controls preload="metadata" />
      ) : (
        <span className="text-sm">音频文件</span>
      )}
    </div>
  );
}

function MediaDialog({
  media,
  description,
  isSaving,
  onDescriptionChange,
  onClose,
  onSave,
  onDelete,
}: {
  media?: CachedMedia;
  description: string;
  isSaving: boolean;
  onDescriptionChange: (description: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <Dialog open={Boolean(media)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm" title={media?.filename}>
            {media?.filename}
          </DialogTitle>
          <DialogDescription>查看原始媒体并编辑其可供代理复用的文字转述。</DialogDescription>
        </DialogHeader>
        {media ? (
          <div className="flex flex-col gap-5">
            <MediaPreview media={media} controls />
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Metadata label="类型" value={mediaLabels[media.kind]} />
              <Metadata label="大小" value={formatBytes(media.size)} />
              <Metadata label="更新时间" value={formatDate(media.updated_at)} className="sm:col-span-2" />
            </div>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="media-description">
              媒体转述
              <Textarea
                id="media-description"
                value={description}
                placeholder="描述媒体中的主体、场景或语音内容"
                className="min-h-20 resize-y text-sm"
                onChange={(event) => onDescriptionChange(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        <DialogFooter className="flex-row flex-wrap justify-between gap-3 sm:justify-between">
          <Button variant="ghost" onClick={onDelete}>
            <Trash2Icon data-icon="inline-start" />
            删除缓存
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              取消
            </Button>
            <Button onClick={onSave} disabled={isSaving}>
              {isSaving ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              保存转述
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metadata({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}
