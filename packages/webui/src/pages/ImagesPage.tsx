import { AudioLines, LoaderCircle, RefreshCw, Search, Trash2, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Input, Modal, Pagination, Popconfirm } from "antd";
import type { CachedMedia } from "@/types";

type MediaPagination = { page: number; page_size: number; total: number; total_pages: number };

function mediaLabel(kind: CachedMedia["kind"]) {
  if (kind === "video") return "视频";
  if (kind === "audio") return "音频";
  return "图片";
}

function MediaPreview({
  media,
  controls = false,
  card = false,
}: {
  media: CachedMedia;
  controls?: boolean;
  card?: boolean;
}) {
  if (media.kind === "video") {
    return (
      <video
        className={
          card
            ? "w-full aspect-[4/3] object-cover bg-[#e9eff2]"
            : "mx-auto block max-h-[60vh] max-w-full rounded-lg object-contain"
        }
        src={media.url}
        controls={controls}
        preload="metadata"
      />
    );
  }
  if (media.kind === "audio") {
    return controls ? (
      <div className="flex justify-center">
        <audio className="w-full max-w-[640px]" src={media.url} controls preload="metadata" />
      </div>
    ) : (
      <div className="grid aspect-[4/3] place-items-center gap-2 bg-[#e9eff2] text-[#526877]">
        <AudioLines size={32} />
        <span className="text-xs">音频</span>
      </div>
    );
  }
  return (
    <img
      className={
        card
          ? "w-full aspect-[4/3] object-cover bg-[#e9eff2]"
          : "mx-auto block max-h-[60vh] max-w-full rounded-lg object-contain"
      }
      src={media.url}
      alt={media.description || media.filename}
    />
  );
}

export function ImagesPage() {
  const [media, setMedia] = useState<CachedMedia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<MediaPagination>({ page: 1, page_size: 48, total: 0, total_pages: 1 });
  const [selectedMedia, setSelectedMedia] = useState<CachedMedia | null>(null);
  const [deleting, setDeleting] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/media?page=${page}&page_size=48&search=${encodeURIComponent(search)}&sort=newest`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "读取媒体缓存失败");
      setMedia(payload.media ?? []);
      setPagination(payload.pagination ?? { page: 1, page_size: 48, total: 0, total_pages: 1 });
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "读取媒体缓存失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [page, search]);
  const deleteSelectedImage = async () => {
    if (!selectedMedia) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(selectedMedia.filename)}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "删除媒体缓存失败");
      setSelectedMedia(null);
      setError("");
      if (media.length === 1 && page > 1) {
        setPage((value) => value - 1);
      } else {
        void load();
      }
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "删除媒体缓存失败");
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="mx-auto max-w-[1240px] px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <div className="mb-5 flex gap-2.5 max-[480px]:flex-col">
        <Input
          className="flex-1"
          prefix={<Search size={17} />}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="搜索文件名或图片描述"
        />
        <button
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9] disabled:cursor-wait disabled:opacity-65"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      {error && (
        <p className="mt-5 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">{error}</p>
      )}
      {loading ? (
        <p className="flex min-h-45 items-center justify-center gap-2 text-sm text-muted">
          <LoaderCircle className="animate-spin" />
          正在读取媒体缓存…
        </p>
      ) : !media.length ? (
        <p className="flex min-h-45 items-center justify-center gap-2 text-sm text-muted">还没有符合条件的媒体。</p>
      ) : (
        <div className="grid grid-cols-4 gap-3.5 max-[820px]:grid-cols-2">
          {media.map((item) => (
            <button
              className="grid min-w-0 overflow-hidden rounded-[10px] b-ui bg-white p-0 text-left text-[#253744] hover:border-[#96bcb0] hover:translate-y--0.25"
              key={item.filename}
              onClick={() => setSelectedMedia(item)}
            >
              <div className="relative">
                <MediaPreview media={item} card />
                {item.kind === "video" && (
                  <Video className="absolute bottom-2 left-2 text-white drop-shadow" size={18} />
                )}
              </div>
              <strong className="overflow-hidden px-2.5 pt-2.5 text-ellipsis whitespace-nowrap font-mono text-xs">
                {item.filename}
              </strong>
              <small className="px-2.5 pb-2.5 pt-1 text-xs text-muted">{mediaLabel(item.kind)}</small>
            </button>
          ))}
        </div>
      )}
      {pagination.total_pages > 1 && (
        <div className="mt-6 flex justify-center">
          <Pagination
            current={pagination.page}
            total={pagination.total}
            pageSize={pagination.page_size}
            showSizeChanger={false}
            disabled={loading}
            onChange={setPage}
          />
        </div>
      )}
      <Modal
        open={Boolean(selectedMedia)}
        destroyOnHidden
        title={selectedMedia?.filename}
        footer={
          <div className="flex justify-start">
            <Popconfirm
              title="删除媒体缓存"
              description="删除后无法恢复，确定要继续吗？"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true, loading: deleting }}
              onConfirm={deleteSelectedImage}
            >
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#fff0f0] px-3.5 py-2 text-sm font-700 text-[#ae3737] hover:bg-[#ffe2e2] disabled:cursor-wait disabled:opacity-65"
                disabled={deleting}
              >
                {deleting ? <LoaderCircle className="animate-spin" size={16} /> : <Trash2 size={16} />}
                {deleting ? "正在删除" : "删除缓存"}
              </button>
            </Popconfirm>
          </div>
        }
        onCancel={() => {
          if (!deleting) setSelectedMedia(null);
        }}
        closable={!deleting}
        maskClosable={!deleting}
      >
        {selectedMedia && (
          <>
            <MediaPreview media={selectedMedia} controls />
            <p className="mt-4 max-h-[24vh] overflow-y-auto whitespace-pre-wrap text-sm leading-[1.6] text-[#40515f]">
              {selectedMedia.description || `暂无${mediaLabel(selectedMedia.kind)}描述。`}
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}
