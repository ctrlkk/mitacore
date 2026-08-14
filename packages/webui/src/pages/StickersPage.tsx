import { ImagePlus, LoaderCircle, Plus, RefreshCw, Search, Sparkles, Trash2, UploadCloud, X } from "lucide-react";
import { Input, Modal, Popconfirm, Select, Upload } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Config, Sticker } from "@/types";

const { TextArea } = Input;

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type StickerSuggestionEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "result";
      suggestion: { name: string; description: string };
    }
  | { type: "error"; message: string };

export function StickersPage({ config }: { config: Config }) {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [limit, setLimit] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedSticker, setSelectedSticker] = useState<Sticker | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionMessage, setSuggestionMessage] = useState("");
  const [suggestionReasoning, setSuggestionReasoning] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newImage, setNewImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");
  const [suggestionModel, setSuggestionModel] = useState("");
  const reasoningRef = useRef<HTMLParagraphElement>(null);

  const modelOptions = useMemo(
    () => [
      ...new Set(config.providers.flatMap((provider) => provider.models.map((model) => model.alias)).filter(Boolean)),
    ],
    [config.providers],
  );

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/stickers");
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "读取贴纸库失败"));
      setStickers(payload.stickers ?? []);
      setLimit(payload.summary?.limit ?? 30);
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "读取贴纸库失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!newImage) {
      setImagePreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(newImage);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [newImage]);

  useEffect(() => {
    const reasoningElement = reasoningRef.current;
    if (reasoningElement) reasoningElement.scrollTop = reasoningElement.scrollHeight;
  }, [suggestionReasoning]);

  const visibleStickers = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return stickers;
    return stickers.filter((sticker) =>
      `${sticker.name}\n${sticker.description}`.toLocaleLowerCase().includes(keyword),
    );
  }, [search, stickers]);

  const openSticker = (sticker: Sticker) => {
    setError("");
    setSelectedSticker(sticker);
  };

  const deleteSelectedSticker = async () => {
    if (!selectedSticker) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/stickers/${encodeURIComponent(selectedSticker.name)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "删除贴纸失败"));
      setStickers((value) => value.filter((sticker) => sticker.name !== selectedSticker.name));
      setSelectedSticker(null);
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "删除贴纸失败");
    } finally {
      setDeleting(false);
    }
  };

  const createSticker = async () => {
    if (!newImage) {
      setError("请选择贴纸图片");
      return;
    }
    setCreating(true);
    try {
      const form = new FormData();
      form.set("name", newName);
      form.set("description", newDescription);
      form.set("image", newImage);
      const response = await fetch("/api/stickers", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(payload, "添加贴纸失败"));
      setCreateOpen(false);
      setNewName("");
      setNewDescription("");
      setNewImage(null);
      setSuggestionMessage("");
      setSuggestionReasoning("");
      setError("");
      await load();
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "添加贴纸失败");
    } finally {
      setCreating(false);
    }
  };

  const suggestSticker = async () => {
    if (!newImage) {
      setError("请先选择贴纸图片");
      return;
    }
    setSuggesting(true);
    setError("");
    setSuggestionMessage("正在上传图片…");
    setSuggestionReasoning("");
    try {
      const form = new FormData();
      form.set("image", newImage);
      if (suggestionModel) form.set("model", suggestionModel);
      const response = await fetch("/api/stickers/suggestion", { method: "POST", body: form });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(getErrorMessage(payload, "生成贴纸表单建议失败"));
      }
      if (!response.body) throw new Error("浏览器不支持读取流式响应");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedResult = false;
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as StickerSuggestionEvent;
        if (event.type === "status") {
          setSuggestionMessage(event.message);
          return;
        }
        if (event.type === "reasoning") {
          setSuggestionReasoning((value) => `${value}${event.delta}`.slice(-20_000));
          return;
        }
        if (event.type === "error") throw new Error(event.message);

        receivedResult = true;
        const { suggestion } = event;
        setNewName(suggestion.name);
        setNewDescription(suggestion.description);
        setSuggestionMessage("已生成贴纸表单建议，可继续修改后添加。");
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      consumeLine(buffer);
      if (!receivedResult) throw new Error("AI 未能生成贴纸表单建议，请重试");
      setError("");
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "生成贴纸表单建议失败");
      setSuggestionMessage("");
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1240px] px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted">
        <span>共 {stickers.length} 张贴纸</span>
        <span>
          容量 {stickers.length} / {limit}
        </span>
      </div>
      <div className="mb-5 flex gap-2.5 max-[480px]:flex-col">
        <Input
          className="flex-1"
          prefix={<Search size={17} />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索贴纸名或描述"
        />
        <button
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9] disabled:cursor-wait disabled:opacity-65"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw size={16} />
          刷新
        </button>
        <button
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-3.5 py-2.5 text-sm font-700 text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-65"
          onClick={() => {
            setError("");
            setCreateOpen(true);
          }}
          disabled={stickers.length >= limit}
        >
          <Plus size={16} />
          添加贴纸
        </button>
      </div>
      {error && (
        <p className="mb-5 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">{error}</p>
      )}
      {loading ? (
        <p className="flex min-h-45 items-center justify-center gap-2 text-sm text-muted">
          <LoaderCircle className="animate-spin" />
          正在读取贴纸库…
        </p>
      ) : !visibleStickers.length ? (
        <div className="flex min-h-55 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#ccd5db] bg-white text-center text-sm text-muted">
          <ImagePlus size={28} strokeWidth={1.5} />
          <span>{stickers.length ? "没有符合条件的贴纸。" : "贴纸库还是空的，添加第一张贴纸吧。"}</span>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3.5 max-[820px]:grid-cols-2">
          {visibleStickers.map((sticker) => (
            <button
              className="grid min-w-0 overflow-hidden rounded-[10px] b-ui bg-white p-0 text-left text-[#253744] hover:border-[#96bcb0] hover:translate-y--0.25"
              key={sticker.name}
              onClick={() => openSticker(sticker)}
            >
              <img
                className="w-full aspect-square object-contain bg-[#f0f2f4] p-2"
                src={sticker.url}
                alt={sticker.name}
              />
              <strong className="overflow-hidden px-2.5 pt-2.5 text-ellipsis whitespace-nowrap font-mono text-xs">
                [{sticker.name}]
              </strong>
              <span className="line-clamp-2 min-h-9 px-2.5 pb-2.5 pt-1 text-[11px] leading-[1.45] text-muted">
                {sticker.description || "暂无描述"}
              </span>
            </button>
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        title="添加贴纸"
        okText={creating ? "正在添加" : "添加"}
        cancelText="取消"
        confirmLoading={creating}
        onOk={createSticker}
        okButtonProps={{ disabled: suggesting }}
        onCancel={() => !creating && !suggesting && setCreateOpen(false)}
        closable={!creating && !suggesting}
        maskClosable={!creating && !suggesting}
      >
        <div className="grid gap-4 py-2">
          {error && (
            <p className="m-0 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">{error}</p>
          )}
          {suggestionReasoning && (
            <div className="rounded-lg bg-[#f4f6f8] px-3 py-2.5">
              <strong className="text-xs text-[#40515f]">AI 思考过程</strong>
              <p
                className="mb-0 mt-1.5 max-h-36 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-[1.6] text-muted"
                ref={reasoningRef}
              >
                {suggestionReasoning}
              </p>
            </div>
          )}
          {suggestionMessage && (
            <p className="m-0 rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
              {suggestionMessage}
            </p>
          )}
          <label className="grid gap-1.5 text-sm font-600">
            贴纸名
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="例如：开心、震惊、晚安"
              maxLength={32}
            />
            <small className="font-400 text-muted">2–32 个字符，发送时使用 [贴纸名]。</small>
          </label>
          <label className="grid gap-1.5 text-sm font-600">
            使用描述
            <TextArea
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              placeholder="说明适用语气、场景、强度和不适用场景"
              rows={4}
              maxLength={500}
              showCount
            />
          </label>
          <label className="grid gap-1.5 text-sm font-600">
            AI 模型
            <Select
              value={suggestionModel || undefined}
              options={[
                { label: `默认图像模型（${config.models.multimodal_image || "未配置"}）`, value: "" },
                ...modelOptions.map((model) => ({ label: model, value: model })),
              ]}
              placeholder="选择用于分析贴纸的模型"
              disabled={suggesting || creating}
              onChange={setSuggestionModel}
            />
            <small className="font-400 text-muted">请仅选择支持图片模态输入的模型；纯文本模型无法分析贴纸图片。</small>
          </label>
          <Upload.Dragger
            accept=".webp,.png,.jpg,.jpeg,.gif"
            maxCount={1}
            showUploadList={false}
            beforeUpload={(file) => {
              setNewImage(file);
              setSuggestionMessage("");
              setSuggestionReasoning("");
              return false;
            }}
          >
            {newImage ? (
              <div className="flex items-center gap-3 p-3 text-left">
                <img
                  className="h-16 w-16 shrink-0 rounded-lg bg-[#f0f2f4] object-contain p-1"
                  src={imagePreviewUrl}
                  alt="待添加贴纸预览"
                />
                <div className="min-w-0 flex-1">
                  <strong className="block overflow-hidden text-sm text-ellipsis whitespace-nowrap">
                    {newImage.name}
                  </strong>
                  <span className="mt-1 block text-xs text-muted">{formatFileSize(newImage.size)} · 点击更换图片</span>
                </div>
                <button
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-[#fff0f0] hover:text-[#ae3737]"
                  type="button"
                  aria-label="移除图片"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setNewImage(null);
                    setSuggestionMessage("");
                    setSuggestionReasoning("");
                  }}
                >
                  <X size={17} />
                </button>
              </div>
            ) : (
              <>
                <UploadCloud className="mx-auto mb-2 text-brand" />
                <p className="m-0 text-sm">拖入或点击选择图片</p>
                <p className="mb-0 mt-1 text-xs text-muted">支持 WebP、PNG、JPG、JPEG、GIF，最大 10 MB</p>
              </>
            )}
          </Upload.Dragger>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9] disabled:cursor-not-allowed disabled:opacity-65"
            type="button"
            onClick={suggestSticker}
            disabled={!newImage || suggesting || creating}
          >
            {suggesting ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />}
            {suggesting ? "AI 正在分析" : "AI 辅助填写"}
          </button>
        </div>
      </Modal>
      <Modal
        open={Boolean(selectedSticker)}
        title={selectedSticker ? `[${selectedSticker.name}]` : "贴纸"}
        footer={
          <div className="flex justify-start">
            <Popconfirm
              title="删除贴纸"
              description="删除后无法恢复，确定要继续吗？"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true, loading: deleting }}
              onConfirm={deleteSelectedSticker}
            >
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#fff0f0] px-3.5 py-2 text-sm font-700 text-[#ae3737] hover:bg-[#ffe2e2] disabled:opacity-65"
                disabled={deleting}
              >
                {deleting ? <LoaderCircle className="animate-spin" size={16} /> : <Trash2 size={16} />}
                删除
              </button>
            </Popconfirm>
          </div>
        }
        onCancel={() => !deleting && setSelectedSticker(null)}
        closable={!deleting}
        maskClosable={!deleting}
      >
        {selectedSticker && (
          <div className="grid gap-4">
            {error && (
              <p className="m-0 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">{error}</p>
            )}
            <img
              className="mx-auto block max-h-[48vh] max-w-full rounded-lg bg-[#f0f2f4] object-contain p-2"
              src={selectedSticker.url}
              alt={selectedSticker.name}
            />
            <div>
              <strong className="text-sm">使用描述</strong>
              <p className="mb-0 mt-1.5 whitespace-pre-wrap text-sm leading-[1.6] text-[#40515f]">
                {selectedSticker.description}
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
