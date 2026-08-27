import { type FormEvent, useEffect, useRef, useState } from "react";
import { ImagePlusIcon, LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const MAX_STICKER_SIZE = 10 * 1024 * 1024;
const stickerNamePattern = /^[\p{L}][\p{L}\p{N}_-]+$/u;

type StickerSuggestionEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "result"; suggestion: { name: string; description: string } }
  | { type: "error"; message: string };

type ConfigResponse = {
  providers: Array<{ models: Array<{ alias: string }> }>;
  models: { multimodal_image?: string };
};

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : fallback;
}

export function StickerCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionModel, setSuggestionModel] = useState("");
  const [modelAliases, setModelAliases] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [suggestionMessage, setSuggestionMessage] = useState("");
  const [suggestionReasoning, setSuggestionReasoning] = useState("");
  const [suggestionError, setSuggestionError] = useState("");
  const reasoningRef = useRef<HTMLParagraphElement>(null);
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const isValidName = stickerNamePattern.test(trimmedName) && trimmedName.length >= 2 && trimmedName.length <= 32;
  const canSubmit = Boolean(file) && isValidName && Boolean(trimmedDescription) && !isCreating && !isSuggesting;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    async function loadModels() {
      try {
        const response = await fetch("/api/config", { signal: controller.signal });
        if (!response.ok) return;
        const config = (await response.json()) as ConfigResponse;
        const aliases = [
          ...new Set(config.providers.flatMap((provider) => provider.models.map((model) => model.alias))),
        ].filter(Boolean);
        if (!controller.signal.aborted) {
          setModelAliases(aliases);
          setDefaultModel(config.models.multimodal_image ?? "");
        }
      } catch {
        // 模型配置不可用时仍可使用默认图像理解模型。
      }
    }

    void loadModels();
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    const reasoningElement = reasoningRef.current;
    if (reasoningElement) reasoningElement.scrollTop = reasoningElement.scrollHeight;
  }, [suggestionReasoning]);

  function resetSuggestion() {
    setSuggestionMessage("");
    setSuggestionReasoning("");
    setSuggestionError("");
  }

  function closeDialog(force = false) {
    if ((isCreating || isSuggesting) && !force) return;
    setFile(undefined);
    setName("");
    setDescription("");
    setPreviewUrl("");
    resetSuggestion();
    onOpenChange(false);
  }

  function selectFile(nextFile: File | undefined) {
    if (nextFile && nextFile.size > MAX_STICKER_SIZE) {
      toast.error("贴纸图片不能超过 10 MB");
      return;
    }
    setFile(nextFile);
    setPreviewUrl(nextFile ? URL.createObjectURL(nextFile) : "");
    resetSuggestion();
  }

  async function createSticker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !canSubmit) return;

    setIsCreating(true);
    try {
      const form = new FormData();
      form.set("name", trimmedName);
      form.set("description", trimmedDescription);
      form.set("image", file);
      const response = await fetch("/api/stickers", { method: "POST", body: form });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getErrorMessage(payload, "添加贴纸失败"));
      toast.success(`贴纸 [${trimmedName}] 已添加`);
      onCreated();
      closeDialog(true);
    } catch (exception) {
      toast.error(exception instanceof Error ? exception.message : "添加贴纸失败");
    } finally {
      setIsCreating(false);
    }
  }

  async function suggestSticker() {
    if (!file || isCreating || isSuggesting) return;

    setIsSuggesting(true);
    setSuggestionError("");
    setSuggestionMessage("正在上传图片…");
    setSuggestionReasoning("");
    try {
      const form = new FormData();
      form.set("image", file);
      if (suggestionModel) form.set("model", suggestionModel);
      const response = await fetch("/api/stickers/suggestion", { method: "POST", body: form });
      if (!response.ok)
        throw new Error(getErrorMessage(await response.json().catch(() => undefined), "生成贴纸表单建议失败"));
      if (!response.body) throw new Error("浏览器不支持读取流式响应");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedResult = false;

      function consumeLine(line: string) {
        if (!line.trim()) return;
        const event = JSON.parse(line) as StickerSuggestionEvent;
        if (event.type === "status") {
          setSuggestionMessage(event.message);
        } else if (event.type === "reasoning") {
          setSuggestionReasoning((current) => `${current}${event.delta}`.slice(-20_000));
        } else if (event.type === "error") {
          throw new Error(event.message);
        } else {
          receivedResult = true;
          setName(event.suggestion.name);
          setDescription(event.suggestion.description);
          setSuggestionMessage("已生成贴纸表单建议，可继续修改后添加。");
        }
      }

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
    } catch (exception) {
      setSuggestionError(exception instanceof Error ? exception.message : "生成贴纸表单建议失败");
      setSuggestionMessage("");
    } finally {
      setIsSuggesting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeDialog()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加贴纸</DialogTitle>
          <DialogDescription>支持 webp、png、jpg、jpeg 和 gif 格式，单个文件不超过 10 MB。</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={(event) => void createSticker(event)}>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="sticker-image">
                贴纸图片
                <Input
                  id="sticker-image"
                  type="file"
                  accept="image/webp,image/png,image/jpeg,image/gif"
                  className="text-sm"
                  disabled={isCreating || isSuggesting}
                  onChange={(event) => selectFile(event.target.files?.[0])}
                />
              </label>
              {previewUrl ? (
                <img
                  className="aspect-square max-h-56 w-full rounded-lg border object-contain"
                  src={previewUrl}
                  alt="待上传贴纸预览"
                />
              ) : (
                <p className="text-xs text-muted-foreground">上传图片后，可让 AI 自动生成名称和场景描述。</p>
              )}
            </div>

            <div className="flex flex-col gap-5">
              {file ? (
                <section className="rounded-xl border bg-muted/30 p-4" aria-labelledby="sticker-ai-assist-title">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-1">
                      <h2 id="sticker-ai-assist-title" className="flex items-center gap-2 text-sm font-medium">
                        <SparklesIcon className="size-4 text-muted-foreground" />
                        AI 辅助填写
                      </h2>
                      <p className="text-xs text-muted-foreground">根据图片生成名称和描述，生成后仍可手动修改。</p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full sm:w-auto"
                      onClick={() => void suggestSticker()}
                      disabled={isCreating || isSuggesting}
                    >
                      {isSuggesting ? (
                        <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <SparklesIcon data-icon="inline-start" />
                      )}
                      {isSuggesting ? "正在分析" : "生成建议"}
                    </Button>
                  </div>
                  {suggestionMessage ? (
                    <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">
                      {suggestionMessage}
                    </p>
                  ) : null}
                  {suggestionError ? (
                    <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {suggestionError}
                    </p>
                  ) : null}
                  {suggestionReasoning ? (
                    <div className="mt-3 rounded-lg border bg-background/50 px-3 py-2.5">
                      <p className="text-xs font-medium">分析过程</p>
                      <p
                        ref={reasoningRef}
                        className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-5 text-muted-foreground"
                      >
                        {suggestionReasoning}
                      </p>
                    </div>
                  ) : null}
                  <details className="mt-3 border-t pt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      模型选项（当前：{suggestionModel || defaultModel || "系统默认"}）
                    </summary>
                    <label className="mt-3 flex flex-col gap-2 text-sm font-medium" htmlFor="sticker-suggestion-model">
                      AI 模型
                      <Select
                        value={suggestionModel || "default"}
                        disabled={isCreating || isSuggesting}
                        onValueChange={(value) => setSuggestionModel(value === "default" ? "" : value)}
                      >
                        <SelectTrigger id="sticker-suggestion-model" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="default">
                              默认图像理解模型{defaultModel ? `（${defaultModel}）` : ""}
                            </SelectItem>
                            {modelAliases.map((model) => (
                              <SelectItem key={model} value={model}>
                                {model}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <span className="text-xs font-normal text-muted-foreground">仅选择支持图片输入的模型。</span>
                    </label>
                  </details>
                </section>
              ) : null}

              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="sticker-name">
                贴纸名称
                <Input
                  id="sticker-name"
                  value={name}
                  placeholder="例如：开心、good_morning"
                  className="text-sm"
                  aria-invalid={Boolean(trimmedName) && !isValidName}
                  disabled={isCreating || isSuggesting}
                  onChange={(event) => setName(event.target.value)}
                />
                <span
                  className={
                    Boolean(trimmedName) && !isValidName ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                  }
                >
                  2 至 32 个字符，以字母开头，可使用字母、数字、下划线和连字符。
                </span>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="sticker-description">
                场景描述
                <Textarea
                  id="sticker-description"
                  value={description}
                  placeholder="描述画面、情绪、语气与适用场景，帮助代理准确调用。"
                  className="min-h-24 resize-y text-sm"
                  disabled={isCreating || isSuggesting}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closeDialog()} disabled={isCreating || isSuggesting}>
              取消
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isCreating ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <ImagePlusIcon data-icon="inline-start" />
              )}
              添加贴纸
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
