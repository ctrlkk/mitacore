import { createDecipheriv, randomBytes } from "node:crypto";

type Fetcher = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

const QQ_BIND_API_BASE_URL = "https://q.qq.com/lite";
const QQ_BIND_PAGE_BASE_URL = "https://q.qq.com/qqbot/openclaw/connect.html";

export interface QQBotQrCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
}

export interface QQBotQrLoginEvents {
  onError(error: Error): void;
  onExpired?(): void;
  onQrUrl(url: string): void;
  onSuccess(credentials: QQBotQrCredentials): void;
}

export interface QQBotQrLoginOptions {
  fetch?: Fetcher;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  source?: string;
}

interface BindTask {
  key: string;
  taskId: string;
}

interface PollResult {
  appId: string;
  encryptedSecret: string;
  status: number;
  userOpenid?: string;
}

/**
 * 启动 QQ 官方 Bot 扫码授权。凭证仅通过回调返回，调用方负责安全保存。
 * 返回的函数可取消正在进行的任务与轮询。
 */
export function startQQBotQrLogin(events: QQBotQrLoginEvents, options: QQBotQrLoginOptions = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  void runQrLogin(events, { ...options, signal: controller.signal })
    .catch((error) => events.onError(toLoginError(error, controller.signal.aborted)))
    .finally(() => options.signal?.removeEventListener("abort", onAbort));

  return () => controller.abort();
}

async function runQrLogin(events: QQBotQrLoginEvents, options: QQBotQrLoginOptions) {
  const fetcher = options.fetch ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  while (!options.signal?.aborted) {
    const task = await createBindTask(fetcher, requestTimeoutMs, options.signal);
    events.onQrUrl(createQrUrl(task.taskId, options.source ?? "openclaw"));

    while (!options.signal?.aborted) {
      let result: PollResult;
      try {
        result = await pollBindResult(fetcher, task.taskId, requestTimeoutMs, options.signal);
      } catch (error) {
        if (options.signal?.aborted) break;
        await sleep(pollIntervalMs, options.signal);
        continue;
      }

      if (result.status === 2) {
        if (!result.appId) throw new Error("QQ Bot 扫码授权结果缺少 appId");
        if (!result.encryptedSecret) throw new Error("QQ Bot 扫码授权结果缺少加密密钥");
        events.onSuccess({
          appId: result.appId,
          appSecret: decryptAppSecret(result.encryptedSecret, task.key),
          userOpenid: result.userOpenid,
        });
        return;
      }
      if (result.status === 3) {
        events.onExpired?.();
        break;
      }
      await sleep(pollIntervalMs, options.signal);
    }
  }
  throw new Error("QQ Bot 扫码授权已取消");
}

async function createBindTask(fetcher: Fetcher, timeoutMs: number, signal?: AbortSignal): Promise<BindTask> {
  const key = randomBytes(32).toString("base64");
  const response = await requestJson<{ retcode?: number; data?: { task_id?: unknown } }>(
    fetcher,
    "create_bind_task",
    { key },
    timeoutMs,
    signal,
  );
  if (response.retcode !== 0) throw new Error("create_bind_task failed");
  const taskId = String(response.data?.task_id ?? "");
  if (!taskId) throw new Error("create_bind_task: missing task_id");
  return { key, taskId };
}

async function pollBindResult(
  fetcher: Fetcher,
  taskId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PollResult> {
  const response = await requestJson<{
    retcode?: number;
    data?: { status?: unknown; bot_appid?: unknown; bot_encrypt_secret?: unknown; user_openid?: unknown };
  }>(fetcher, "poll_bind_result", { task_id: taskId }, timeoutMs, signal);
  if (response.retcode !== 0) throw new Error("poll_bind_result failed");
  return {
    status: Number(response.data?.status ?? 0),
    appId: String(response.data?.bot_appid ?? ""),
    encryptedSecret: String(response.data?.bot_encrypt_secret ?? ""),
    userOpenid: response.data?.user_openid ? String(response.data.user_openid) : undefined,
  };
}

async function requestJson<T>(
  fetcher: Fetcher,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(endpoint, `${QQ_BIND_API_BASE_URL}/`).toString();
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`QQ Bot 扫码接口请求失败：HTTP ${response.status}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("QQ Bot 扫码接口返回无效 JSON");
    }
  } catch (error) {
    if (signal?.aborted) throw new Error("QQ Bot 扫码授权已取消");
    if (controller.signal.aborted) throw new Error(`QQ Bot 扫码接口请求超时：${endpoint}`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function createQrUrl(taskId: string, source: string) {
  const url = new URL(QQ_BIND_PAGE_BASE_URL);
  url.searchParams.set("task_id", taskId);
  url.searchParams.set("source", source);
  url.searchParams.set("_wv", "2");
  return url.toString();
}

function decryptAppSecret(encryptedSecret: string, taskKey: string) {
  const packed = Buffer.from(encryptedSecret, "base64");
  if (packed.length < 29) throw new Error("QQ Bot 加密密钥格式无效");
  const key = Buffer.from(taskKey, "base64");
  if (key.length !== 32) throw new Error("QQ Bot 绑定任务密钥长度无效");

  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(-16));
  return Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString("utf8");
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toLoginError(error: unknown, cancelled: boolean) {
  if (cancelled) return new Error("QQ Bot 扫码授权已取消");
  return error instanceof Error ? error : new Error(String(error));
}
