import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Mutex } from "async-mutex";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { z } from "zod";

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream";
const DEFAULT_RESOURCE_ID = "seed-tts-2.0";
const DEFAULT_TIMEOUT_MS = 60_000;

const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9;
const MESSAGE_TYPE_AUDIO_ONLY_SERVER = 0xb;
const MESSAGE_TYPE_ERROR = 0xf;
const FLAG_WITH_EVENT = 0x4;
const EVENT_SESSION_FINISHED = 152;
const EVENT_TTS_RESPONSE = 352;

export const DoubaoTtsModelSchema = z.enum(["seed-tts-2.0-standard", "seed-tts-2.0-expressive"]);

const SessionFinishedResponseSchema = z.object({
  status_code: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  usage: z
    .object({
      text_words: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type DoubaoTtsAudioFormat = "mp3" | "pcm" | "ogg_opus";
export type DoubaoTtsSampleRate = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
export type DoubaoTtsModel = z.infer<typeof DoubaoTtsModelSchema>;

export interface DoubaoTtsClientOptions {
  /** 新版控制台生成的 API Key。 */
  apiKey: string;
  /** 握手使用的资源 ID，预置音色默认为 `seed-tts-2.0`，复刻音色使用 `seed-icl-2.0`。 */
  resourceId?: string;
  /** WebSocket 接口地址，默认使用豆包 V3 单向流式合成地址。 */
  endpoint?: string;
  /** 建连和单次合成的超时时间，单位为毫秒，默认 60000。 */
  timeoutMs?: number;
}

export interface DoubaoTtsSynthesisOptions {
  /** 控制台音色库中的预置或复刻音色 ID。 */
  speaker: string;
  /** 复刻音色需要指定合成模型，预置音色无需设置。 */
  model?: DoubaoTtsModel;
  /** 复刻 2.0 同语种合成时尽量还原训练音频的风格、口音和韵律。 */
  toneFidelity?: boolean;
  /**
   * 自然语言语音指令或只引用不合成的对话上文。
   * 复刻音色需使用表现力增强版模型，标准版会过滤此参数。
   */
  contextTexts?: string[];
  /** SSML 标记文本；启用后服务端会按 SSML 规则解析 `text`。 */
  ssml?: string;
  /** 输出音频格式，默认 `mp3`；流式场景推荐 `pcm`。 */
  format?: DoubaoTtsAudioFormat;
  /** 输出采样率，默认 24000 Hz；`ogg_opus` 仅支持 48000 Hz。 */
  sampleRate?: DoubaoTtsSampleRate;
  /** MP3 或 OGG Opus 比特率，PCM 不支持设置。 */
  bitRate?: 64000 | 160000;
  /** 语速调节，取值范围为 -50 至 100，默认 0。 */
  speechRate?: number;
  /** 音量调节，取值范围为 -50 至 100，默认 0。 */
  loudnessRate?: number;
  /** 是否返回字级时间戳字幕，仅支持中文和英文，默认关闭。 */
  enableSubtitle?: boolean;
  /** 协议 `additions` 扩展参数；封装会自动序列化为 JSON 字符串。 */
  additions?: Record<string, unknown>;
  /** 用于取消排队、建连或正在进行的合成请求。 */
  signal?: AbortSignal;
  /** 每收到一个音频分片时调用；异步回调会按接收顺序串行执行。 */
  onAudioChunk?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface DoubaoTtsResult {
  /** 按接收顺序拼接后的完整音频。 */
  audio: Blob;
  /** 当前 WebSocket 连接的客户端请求 ID。 */
  requestId: string;
  /** 服务端 Log ID，可用于问题排查。 */
  logId?: string;
  /** 服务端合成会话 ID。 */
  sessionId?: string;
  /** 服务端返回的计费字符数。 */
  textWords?: number;
}

type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

interface ParsedFrame {
  messageType: number;
  event?: number;
  sessionId?: string;
  errorCode?: number;
  payload: Buffer;
}

/**
 * 豆包 V3 单向流式语音合成客户端。
 * 同一客户端会串行复用 WebSocket，避免每段文本都重新握手。
 */
export class DoubaoTtsClient {
  private readonly apiKey: string;
  private readonly resourceId: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly webSocketFactory: WebSocketFactory;
  // 单向接口的客户端请求不携带 Session ID，同一连接上并发发送会无法可靠匹配响应。
  private readonly synthesisLock = new Mutex();
  private socket: WebSocket | null = null;
  private connectPromise: Promise<WebSocket> | null = null;
  private requestId = "";
  private logId?: string;

  constructor(options: DoubaoTtsClientOptions, webSocketFactory: WebSocketFactory = createWebSocket) {
    if (!options.apiKey) throw new Error("豆包 TTS API Key 不能为空");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("豆包 TTS 超时时间必须大于 0");
    }

    this.apiKey = options.apiKey;
    this.resourceId = options.resourceId ?? DEFAULT_RESOURCE_ID;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.webSocketFactory = webSocketFactory;
  }

  async synthesize(text: string, options: DoubaoTtsSynthesisOptions): Promise<DoubaoTtsResult> {
    if (!text.trim()) throw new Error("豆包 TTS 待合成文本不能为空");
    if (!options.speaker) throw new Error("豆包 TTS 音色 ID 不能为空");
    if (options.model === "seed-tts-2.0-standard" && options.contextTexts?.length) {
      throw new Error("豆包 TTS 标准版模型不支持使用语音指令或引用上下文");
    }
    options.signal?.throwIfAborted();

    const release = await acquireMutex(this.synthesisLock, options.signal);
    try {
      options.signal?.throwIfAborted();
      const socket = await this.connect(options.signal);
      options.signal?.throwIfAborted();
      return this.runSynthesis(socket, text, options);
    } finally {
      release();
    }
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "normal");
  }

  private async connect(signal?: AbortSignal) {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connectPromise) return this.connectPromise;

    this.requestId = randomUUID();
    this.logId = undefined;
    const socket = this.webSocketFactory(this.endpoint, {
      headers: {
        "X-Api-Key": this.apiKey,
        "X-Api-Resource-Id": this.resourceId,
        "X-Api-Request-Id": this.requestId,
        "X-Control-Require-Usage-Tokens-Return": "*",
      },
    });
    this.socket = socket;

    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error(`豆包 TTS WebSocket 连接超时：${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", handleAbort);
        socket.off("open", handleOpen);
        socket.off("error", handleError);
        socket.off("close", handleClose);
      };
      const fail = (error: Error) => {
        cleanup();
        if (this.socket === socket) this.socket = null;
        socket.terminate();
        reject(error);
      };
      const handleOpen = () => {
        cleanup();
        // 连接空闲期间也必须消费 error 事件，否则 ws 会把它作为未处理异常抛出。
        socket.on("error", handleIdleError);
        socket.once("close", handleIdleClose);
        resolve(socket);
      };
      const handleIdleError = () => {
        if (this.socket === socket) this.socket = null;
      };
      const handleIdleClose = () => {
        socket.off("error", handleIdleError);
        if (this.socket === socket) this.socket = null;
      };
      const handleError = (error: Error) => fail(new Error(`豆包 TTS WebSocket 连接失败：${error.message}`));
      const handleClose = (code: number, reason: Buffer) =>
        fail(new Error(`豆包 TTS WebSocket 在连接建立前关闭：${code} ${reason.toString()}`.trim()));
      const handleAbort = () => fail(toError(signal?.reason, "豆包 TTS WebSocket 连接已取消"));

      socket.once("upgrade", (response) => {
        const value = response.headers["x-tt-logid"];
        this.logId = Array.isArray(value) ? value[0] : value;
      });
      socket.once("open", handleOpen);
      socket.once("error", handleError);
      socket.once("close", handleClose);
      signal?.addEventListener("abort", handleAbort, { once: true });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private runSynthesis(socket: WebSocket, text: string, options: DoubaoTtsSynthesisOptions) {
    const format = options.format ?? "mp3";
    const chunks: Buffer[] = [];

    return new Promise<DoubaoTtsResult>((resolve, reject) => {
      let settled = false;
      let finishing = false;
      let chunkChain = Promise.resolve();
      const timer = setTimeout(() => fail(new Error(`豆包 TTS 合成超时：${this.timeoutMs}ms`)), this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", handleAbort);
        socket.off("message", handleMessage);
        socket.off("error", handleError);
        socket.off("close", handleClose);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // 请求失败时可能仍有当前会话的音频帧在途，连接不能交给下一次合成继续复用。
        if (this.socket === socket) this.socket = null;
        socket.terminate();
        reject(error);
      };
      const finish = (frame: ParsedFrame) => {
        if (settled || finishing) return;
        finishing = true;
        socket.off("message", handleMessage);
        socket.off("error", handleError);
        socket.off("close", handleClose);
        // SessionFinished 只表示服务端发送完毕，仍需等待调用方按顺序处理完所有音频分片。
        chunkChain.then(
          () => {
            try {
              const metadata = parseSessionFinishedResponse(frame.payload);
              if (metadata.status_code !== undefined && String(metadata.status_code) !== "20000000") {
                fail(new Error(`豆包 TTS 合成失败：${metadata.status_code} ${metadata.message ?? "未知错误"}`));
                return;
              }
              if (chunks.length === 0) {
                fail(new Error("豆包 TTS 合成完成但未返回音频数据"));
                return;
              }
              if (settled) return;
              settled = true;
              cleanup();
              resolve({
                audio: new Blob([Uint8Array.from(Buffer.concat(chunks))], { type: audioContentType(format) }),
                requestId: this.requestId,
                logId: this.logId,
                sessionId: frame.sessionId,
                textWords: metadata.usage?.text_words,
              });
            } catch (error) {
              fail(toError(error, "解析豆包 TTS 会话结束响应失败"));
            }
          },
          (error) => fail(toError(error, "豆包 TTS 音频分片处理失败")),
        );
      };
      const handleAbort = () => fail(toError(options.signal?.reason, "豆包 TTS 合成已取消"));
      const handleError = (error: Error) => fail(new Error(`豆包 TTS WebSocket 异常：${error.message}`));
      const handleClose = (code: number, reason: Buffer) =>
        fail(new Error(`豆包 TTS WebSocket 在合成完成前关闭：${code} ${reason.toString()}`.trim()));
      const handleMessage = (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          fail(new Error("豆包 TTS 返回了非二进制消息"));
          return;
        }

        try {
          const frame = parseFrame(rawDataToBuffer(data));
          if (frame.messageType === MESSAGE_TYPE_ERROR) {
            fail(
              new Error(`豆包 TTS 合成失败：${frame.errorCode ?? "未知错误"} ${frame.payload.toString("utf8")}`.trim()),
            );
            return;
          }

          if (frame.messageType === MESSAGE_TYPE_AUDIO_ONLY_SERVER && frame.event === EVENT_TTS_RESPONSE) {
            chunks.push(frame.payload);
            if (options.onAudioChunk) {
              const chunk = new Uint8Array(frame.payload);
              // WebSocket 消息到达是同步回调，显式串联 Promise 以保持异步消费者的分片顺序。
              chunkChain = chunkChain.then(() => options.onAudioChunk?.(chunk));
              chunkChain.catch((error) => fail(toError(error, "豆包 TTS 音频分片处理失败")));
            }
            return;
          }

          if (frame.messageType === MESSAGE_TYPE_FULL_SERVER_RESPONSE && frame.event === EVENT_SESSION_FINISHED) {
            finish(frame);
          }
        } catch (error) {
          fail(toError(error, "解析豆包 TTS 响应失败"));
        }
      };

      options.signal?.addEventListener("abort", handleAbort, { once: true });
      socket.on("message", handleMessage);
      socket.once("error", handleError);
      socket.once("close", handleClose);

      socket.send(createSynthesisFrame(text, options), { binary: true }, (error) => {
        if (error) fail(new Error(`发送豆包 TTS 请求失败：${error.message}`));
      });
    });
  }
}

function createWebSocket(url: string, options: ClientOptions) {
  return new WebSocket(url, options);
}

function createSynthesisFrame(text: string, options: DoubaoTtsSynthesisOptions) {
  const payload = Buffer.from(
    JSON.stringify({
      req_params: {
        text,
        speaker: options.speaker,
        ...(options.model ? { model: options.model } : {}),
        ...(options.toneFidelity !== undefined ? { tone_fidelity: options.toneFidelity } : {}),
        ...(options.contextTexts !== undefined ? { context_texts: options.contextTexts } : {}),
        ...(options.ssml !== undefined ? { ssml: options.ssml } : {}),
        audio_params: {
          format: options.format ?? "mp3",
          sample_rate: options.sampleRate ?? 24000,
          ...(options.bitRate !== undefined ? { bit_rate: options.bitRate } : {}),
          ...(options.speechRate !== undefined ? { speech_rate: options.speechRate } : {}),
          ...(options.loudnessRate !== undefined ? { loudness_rate: options.loudnessRate } : {}),
          ...(options.enableSubtitle !== undefined ? { enable_subtitle: options.enableSubtitle } : {}),
        },
        ...(options.additions ? { additions: JSON.stringify(options.additions) } : {}),
      },
    }),
    "utf8",
  );
  const frame = Buffer.allocUnsafe(8 + payload.length);
  // V3 请求帧：4 字节协议头 + 4 字节大端 payload 长度 + UTF-8 JSON。
  frame.set([0x11, 0x10, 0x10, 0x00], 0);
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

function parseFrame(frame: Buffer): ParsedFrame {
  ensureBytes(frame, 0, 4);
  // 固定头的每个字节由两个 4-bit 字段组成，多字节数值均使用大端序。
  const version = frame[0]! >> 4;
  const headerSize = (frame[0]! & 0x0f) * 4;
  const messageType = frame[1]! >> 4;
  const flags = frame[1]! & 0x0f;
  const serialization = frame[2]! >> 4;
  const compression = frame[2]! & 0x0f;
  if (version !== 1) throw new Error(`不支持的协议版本：${version}`);
  if (headerSize < 4) throw new Error(`无效的协议头长度：${headerSize}`);
  if (serialization !== 0 && serialization !== 1) throw new Error(`不支持的序列化方式：${serialization}`);
  if (compression !== 0 && compression !== 1) throw new Error(`不支持的压缩方式：${compression}`);

  let offset = headerSize;
  if (messageType === MESSAGE_TYPE_ERROR) {
    ensureBytes(frame, offset, 8);
    const errorCode = frame.readUInt32BE(offset);
    const payloadSize = frame.readUInt32BE(offset + 4);
    offset += 8;
    return { messageType, errorCode, payload: readPayload(frame, offset, payloadSize, compression) };
  }

  if (flags === 0x1 || flags === 0x3) {
    ensureBytes(frame, offset, 4);
    offset += 4;
  }

  let event: number | undefined;
  let sessionId: string | undefined;
  if (flags === FLAG_WITH_EVENT) {
    ensureBytes(frame, offset, 8);
    event = frame.readInt32BE(offset);
    const sessionIdSize = frame.readUInt32BE(offset + 4);
    offset += 8;
    ensureBytes(frame, offset, sessionIdSize);
    sessionId = frame.subarray(offset, offset + sessionIdSize).toString("utf8");
    offset += sessionIdSize;
  }

  ensureBytes(frame, offset, 4);
  const payloadSize = frame.readUInt32BE(offset);
  offset += 4;
  return { messageType, event, sessionId, payload: readPayload(frame, offset, payloadSize, compression) };
}

function readPayload(frame: Buffer, offset: number, size: number, compression: number) {
  ensureBytes(frame, offset, size);
  if (offset + size !== frame.length) throw new Error("豆包 TTS 响应帧包含多余数据");
  const payload = frame.subarray(offset, offset + size);
  return compression === 1 ? gunzipSync(payload) : payload;
}

function ensureBytes(frame: Buffer, offset: number, size: number) {
  if (offset < 0 || size < 0 || offset + size > frame.length) throw new Error("豆包 TTS 响应帧长度无效");
}

function rawDataToBuffer(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function parseSessionFinishedResponse(payload: Buffer) {
  const value = payload.length === 0 ? {} : JSON.parse(payload.toString("utf8"));
  return SessionFinishedResponseSchema.parse(value);
}

function audioContentType(format: DoubaoTtsAudioFormat) {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "pcm":
      return "audio/pcm";
    case "ogg_opus":
      return "audio/ogg; codecs=opus";
  }
}

async function acquireMutex(mutex: Mutex, signal?: AbortSignal) {
  if (!signal) return mutex.acquire();
  signal.throwIfAborted();

  return new Promise<() => void>((resolve, reject) => {
    let aborted = false;
    const handleAbort = () => {
      aborted = true;
      reject(toError(signal.reason, "豆包 TTS 合成已取消"));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    mutex.acquire().then(
      (release) => {
        signal.removeEventListener("abort", handleAbort);
        // 取消可能先于排队中的 acquire 完成，此时仍要释放后来取得的锁。
        if (aborted) release();
        else resolve(release);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

function toError(value: unknown, fallback: string) {
  return value instanceof Error ? value : new Error(fallback);
}
