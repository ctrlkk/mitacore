import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { CachedImage } from "../types";

export function ImagesPage() {
  const [images, setImages] = useState<CachedImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
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
  return (
    <div className="library">
      <div className="toolbar">
        <label>
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索文件名或图片描述"
          />
        </label>
        <button className="button secondary" onClick={load} disabled={loading}>
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      {error && <p className="notice error">{error}</p>}
      {loading ? (
        <p className="empty">
          <LoaderCircle className="spin" />
          正在读取图片缓存…
        </p>
      ) : !images.length ? (
        <p className="empty">还没有符合条件的图片。</p>
      ) : (
        <div className="image-grid">
          {images.map((image) => (
            <a className="image-card" key={image.filename} href={image.url} target="_blank" rel="noreferrer">
              <img src={image.url} alt={image.description || image.filename} />
              <strong>{image.filename}</strong>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
