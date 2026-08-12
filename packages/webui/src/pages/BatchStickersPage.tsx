import { CheckCircle2, ImagePlus, LoaderCircle, UploadCloud, X } from "lucide-react";
import { Select, Upload } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Config } from "../types";

type SuggestionEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "result"; suggestion: { suitable: boolean; name: string; description: string; reason: string } }
  | { type: "error"; message: string };

type BatchSticker = {
  id: string;
  image: File;
  previewUrl: string;
  status: "pending" | "creating" | "created" | "error";
  phase: string;
  message: string;
  progress: number;
  reasoning: string;
};

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : fallback;
}

export function BatchStickersPage({ config }: { config: Config }) {
  const navigate = useNavigate();
  const [stickersCount, setStickersCount] = useState(0);
  const [limit, setLimit] = useState(30);
  const [batchStickers, setBatchStickers] = useState<BatchSticker[]>([]);
  const [batchModel, setBatchModel] = useState("");
  const [batchConcurrency, setBatchConcurrency] = useState(3);
  const [batchCreating, setBatchCreating] = useState(false);
  const aliases = useMemo(
    () => [
      ...new Set(config.providers.flatMap((provider) => provider.models.map((model) => model.alias)).filter(Boolean)),
    ],
    [config.providers],
  );

  const loadSummary = async () => {
    const response = await fetch("/api/stickers");
    const payload = await response.json();
    if (!response.ok) throw new Error(getErrorMessage(payload, "读取贴纸库失败"));
    setStickersCount(payload.stickers?.length ?? 0);
    setLimit(payload.summary?.limit ?? 30);
  };

  useEffect(() => {
    void loadSummary();
  }, []);

  const update = (id: string, patch: Partial<BatchSticker>) => {
    setBatchStickers((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const createOne = async (item: BatchSticker) => {
    update(item.id, { status: "creating", phase: "准备图片", message: "正在准备图片…", progress: 10 });
    const suggestionForm = new FormData();
    suggestionForm.set("image", item.image);
    if (batchModel) suggestionForm.set("model", batchModel);
    const suggestionResponse = await fetch("/api/stickers/suggestion", { method: "POST", body: suggestionForm });
    if (!suggestionResponse.ok) throw new Error(getErrorMessage(await suggestionResponse.json(), "生成贴纸建议失败"));
    if (!suggestionResponse.body) throw new Error("浏览器不支持读取流式响应");

    const reader = suggestionResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let suggestion: Extract<SuggestionEvent, { type: "result" }>["suggestion"] | undefined;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as SuggestionEvent;
      if (event.type === "status") {
        const organizing = event.message.includes("整理");
        const analyzing = event.message.includes("分析");
        update(item.id, {
          phase: organizing ? "生成建议" : analyzing ? "分析图片" : "上传图片",
          message: event.message,
          progress: organizing ? 75 : analyzing ? 45 : 20,
        });
      } else if (event.type === "reasoning") {
        setBatchStickers((items) =>
          items.map((sticker) =>
            sticker.id === item.id
              ? { ...sticker, reasoning: `${sticker.reasoning}${event.delta}`.slice(-20_000) }
              : sticker,
          ),
        );
      } else if (event.type === "result") {
        suggestion = event.suggestion;
      } else {
        throw new Error(event.message);
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    }
    consume(`${buffer}${decoder.decode()}`);
    if (!suggestion) throw new Error("AI 未能生成贴纸建议，请重试");
    if (!suggestion.suitable) throw new Error(suggestion.reason || "这张图片不适合作为贴纸。");

    update(item.id, { phase: "写入贴纸库", message: "正在创建贴纸…", progress: 85 });
    const form = new FormData();
    form.set("name", suggestion.name);
    form.set("description", suggestion.description);
    form.set("image", item.image);
    const response = await fetch("/api/stickers", { method: "POST", body: form });
    if (!response.ok) throw new Error(getErrorMessage(await response.json(), "添加贴纸失败"));
    update(item.id, { status: "created", phase: "已完成", message: `已创建 [${suggestion.name}]`, progress: 100 });
  };

  const createBatch = async () => {
    if (batchStickers.length > limit - stickersCount) return;
    setBatchCreating(true);
    const queue = batchStickers.filter((item) => item.status === "pending");
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        try {
          await createOne(item);
        } catch (error) {
          update(item.id, {
            status: "error",
            phase: "创建失败",
            message: error instanceof Error ? error.message : "创建贴纸失败",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(batchConcurrency, queue.length) }, worker));
    setBatchCreating(false);
    await loadSummary();
  };

  const remove = (item: BatchSticker) => {
    URL.revokeObjectURL(item.previewUrl);
    setBatchStickers((items) => items.filter((sticker) => sticker.id !== item.id));
  };

  return (
    <div className="mx-auto grid max-w-[1240px] gap-5 px-[clamp(20px,5vw,72px)] pb-16 pt-7.5 max-[480px]:px-3.5 max-[480px]:pb-10 max-[480px]:pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">STICKER BATCH</p>
          <h2 className="m-0 text-xl tracking-[-0.02em]">批量创建贴纸</h2>
          <p className="mb-0 mt-1.5 text-xs text-muted">
            容量 {stickersCount} / {limit}。每张图片将独立分析并创建。
          </p>
        </div>
        <button
          className="rounded-lg border border-[#d5dde2] bg-white px-3.5 py-2 text-sm font-700 text-[#294051] hover:bg-[#f4f6f8]"
          onClick={() => navigate("/stickers")}
          disabled={batchCreating}
        >
          返回贴纸库
        </button>
      </div>
      <section className="grid gap-4 rounded-[14px] b-ui bg-white p-6 shadow-[0_1px_2px_#17212b08] max-[480px]:p-4">
        <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
          <label className="grid gap-1.5 text-sm font-600">
            AI 模型
            <Select
              value={batchModel || undefined}
              disabled={batchCreating}
              onChange={setBatchModel}
              options={[
                { label: `默认图像模型（${config.models.multimodal_image || "未配置"}）`, value: "" },
                ...aliases.map((value) => ({ label: value, value })),
              ]}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-600">
            并发数
            <Select
              value={batchConcurrency}
              disabled={batchCreating}
              onChange={setBatchConcurrency}
              options={[1, 2, 3, 4, 5].map((value) => ({ label: `${value} 个任务`, value }))}
            />
          </label>
        </div>
        <Upload.Dragger
          accept=".webp,.png,.jpg,.jpeg,.gif"
          multiple
          showUploadList={false}
          disabled={batchCreating}
          beforeUpload={(file) => {
            setBatchStickers((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                image: file,
                previewUrl: URL.createObjectURL(file),
                status: "pending",
                phase: "排队中",
                message: "等待创建",
                progress: 0,
                reasoning: "",
              },
            ]);
            return false;
          }}
        >
          <UploadCloud className="mx-auto mb-2 text-brand" />
          <p className="m-0 text-sm">拖入或点击选择多张图片</p>
          <p className="mb-0 mt-1 text-xs text-muted">支持 WebP、PNG、JPG、JPEG、GIF，单张最大 10 MB</p>
        </Upload.Dragger>
        {batchStickers.length > 0 && <p className="m-0 text-xs text-muted">已添加 {batchStickers.length} 张图片</p>}
        <div className="grid grid-cols-3 gap-3 max-[960px]:grid-cols-2 max-[600px]:grid-cols-1">
          {batchStickers.map((item) => (
            <article className="grid gap-2 rounded-lg border border-[#b2d4c8] bg-[#fbfcfd] p-2.5 text-xs" key={item.id}>
              <img
                className="aspect-[4/3] w-full rounded-md bg-[#edf1f3] object-contain"
                src={item.previewUrl}
                alt={item.image.name}
              />
              <div className="flex min-w-0 items-center gap-2">
                {item.status === "creating" ? (
                  <LoaderCircle className="shrink-0 animate-spin text-brand" size={15} />
                ) : item.status === "created" ? (
                  <CheckCircle2 className="shrink-0 text-[#4f9d79]" size={15} />
                ) : (
                  <ImagePlus className="shrink-0 text-muted" size={15} />
                )}
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {item.image.name}
                </span>
                <span className={item.status === "error" ? "font-700 text-[#ae3737]" : "font-700 text-[#40515f]"}>
                  {item.phase}
                </span>
                {!batchCreating && (
                  <button
                    className="grid h-5 w-5 place-items-center text-muted hover:text-[#ae3737]"
                    onClick={() => remove(item)}
                    aria-label={`移除 ${item.image.name}`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[#e9eff2]">
                <div
                  className={item.status === "error" ? "h-full bg-[#d45c5c]" : "h-full bg-brand"}
                  style={{ width: `${item.progress}%` }}
                />
              </div>
              <div className="flex justify-between gap-3 text-muted">
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{item.message}</span>
                <span className="font-mono">{item.progress}%</span>
              </div>
              {item.reasoning && (
                <div className="rounded bg-[#f1f4f6] px-2 py-1.5">
                  <strong className="text-[10px] tracking-[0.08em] text-[#40515f]">AI 思考输出</strong>
                  <p className="mb-0 mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-muted">
                    {item.reasoning}
                  </p>
                </div>
              )}
            </article>
          ))}
        </div>
        {batchStickers.length > limit - stickersCount && (
          <p className="m-0 text-xs text-[#ae3737]">
            已添加 {batchStickers.length} 张，但剩余容量仅 {limit - stickersCount} 张。
          </p>
        )}
        <div className="flex justify-end">
          <button
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-3.5 py-2 text-sm font-700 text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-65"
            disabled={
              !batchStickers.some((item) => item.status === "pending") ||
              batchStickers.length > limit - stickersCount ||
              batchCreating
            }
            onClick={createBatch}
          >
            {batchCreating && <LoaderCircle className="animate-spin" size={16} />}
            {batchCreating
              ? "正在批量创建"
              : `创建 ${batchStickers.filter((item) => item.status === "pending").length} 张`}
          </button>
        </div>
      </section>
    </div>
  );
}
