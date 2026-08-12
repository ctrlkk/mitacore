import { LoaderCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Input, Modal, Popconfirm } from "antd";
import type { CachedImage } from "@/types";

export function ImagesPage() {
  const [images, setImages] = useState<CachedImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedImage, setSelectedImage] = useState<CachedImage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/images?page=1&page_size=48&search=${encodeURIComponent(search)}&sort=newest`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "读取图片缓存失败");
      setImages(payload.images ?? []);
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "读取图片缓存失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const deleteSelectedImage = async () => {
    if (!selectedImage) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/images/${encodeURIComponent(selectedImage.filename)}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "删除图片缓存失败");
      setImages((value) => value.filter((image) => image.filename !== selectedImage.filename));
      setSelectedImage(null);
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "删除图片缓存失败");
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
          onChange={(event) => setSearch(event.target.value)}
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
          正在读取图片缓存…
        </p>
      ) : !images.length ? (
        <p className="flex min-h-45 items-center justify-center gap-2 text-sm text-muted">还没有符合条件的图片。</p>
      ) : (
        <div className="grid grid-cols-4 gap-3.5 max-[820px]:grid-cols-2">
          {images.map((image) => (
            <button
              className="grid min-w-0 overflow-hidden rounded-[10px] b-ui bg-white p-0 text-left text-[#253744] hover:border-[#96bcb0] hover:translate-y--0.25"
              key={image.filename}
              onClick={() => setSelectedImage(image)}
            >
              <img
                className="w-full aspect-[4/3] object-cover bg-[#e9eff2]"
                src={image.url}
                alt={image.description || image.filename}
              />
              <strong className="overflow-hidden px-2.5 pt-2.5 text-ellipsis whitespace-nowrap font-mono text-xs">
                {image.filename}
              </strong>
            </button>
          ))}
        </div>
      )}
      <Modal
        open={Boolean(selectedImage)}
        title={selectedImage?.filename}
        footer={
          <div className="flex justify-start">
            <Popconfirm
              title="删除图片缓存"
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
          if (!deleting) setSelectedImage(null);
        }}
        closable={!deleting}
        maskClosable={!deleting}
      >
        {selectedImage && (
          <>
            <img
              className="mx-auto block max-h-[60vh] max-w-full rounded-lg object-contain"
              src={selectedImage.url}
              alt={selectedImage.description || selectedImage.filename}
            />
            <p className="mt-4 max-h-[24vh] overflow-y-auto whitespace-pre-wrap text-sm leading-[1.6] text-[#40515f]">
              {selectedImage.description || "暂无图片描述。"}
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}
