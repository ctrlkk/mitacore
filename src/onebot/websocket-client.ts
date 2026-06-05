export type OneBotEcho = string | number;
export type OneBotMessage = string | OneBotMessageSegment | OneBotMessageSegment[] | OneBotMessageChainLike;

export interface OneBotMessageChainLike {
    toSegments(): unknown[];
}

export interface TextSegment {
    type: 'text';
    data: { text: string };
}

export interface ImageSegment {
    type: 'image';
    data: { file: string; file_size?: number | string; url: string };
}

export interface VideoSegment {
    type: 'video';
    data: { file: string; file_size?: number | string; url: string };
}

export interface RecordSegment {
    type: 'record';
    data: { file: string; file_size?: number | string; url: string };
}

export interface AtSegment {
    type: 'at';
    data: { qq: string };
}

export interface FaceSegment {
    type: 'face';
    data: Record<string, unknown>;
}

export interface ReplySegment {
    type: 'reply';
    data: { id: string };
}

export interface FileSegment {
    type: 'file';
    data: { file: string; file_name?: string; file_size?: number | string; url?: string };
}

export type OneBotMessageSegment = TextSegment | ImageSegment | VideoSegment | RecordSegment | AtSegment | FaceSegment | ReplySegment | FileSegment;

export interface OneBotApiParams {
    [key: string]: unknown;
}

export interface ApiResponse<TData = any> {
    status: 'ok' | 'failed';
    retcode: number;
    data: TData;
    echo?: OneBotEcho;
    wording?: string;
}

export interface OneBotBaseEvent {
    time: number;
    self_id: number;
    post_type: string;
    [key: string]: unknown;
}

export interface OneBotSender {
    user_id: number;
    nickname: string;
    sex?: 'male' | 'female' | 'unknown' | string;
    age?: number;
    card?: string;
    area?: string;
    level?: string;
    role?: 'owner' | 'admin' | 'member' | string;
    title?: string;
    [key: string]: unknown;
}

export interface OneBotStrangerInfo {
    user_id: number;
    nickname: string;
    sex: 'male' | 'female' | 'unknown' | string;
    age: number;
    qid?: string;
    level?: number;
    login_days?: number;
    [key: string]: unknown;
}

export interface OneBotGroupMemberInfo {
    group_id: number;
    user_id: number;
    nickname: string;
    card: string;
    sex: 'male' | 'female' | 'unknown' | string;
    age: number;
    area: string;
    join_time: number;
    last_sent_time: number;
    level: string;
    role: 'owner' | 'admin' | 'member' | string;
    unfriendly: boolean;
    title: string;
    title_expire_time: number;
    card_changeable: boolean;
    [key: string]: unknown;
}

export interface OneBotPrivateMessageEvent extends OneBotBaseEvent {
    post_type: 'message' | 'message_sent';
    message_type: 'private';
    sub_type: string;
    message_id: number;
    user_id: number;
    message: OneBotMessageSegment[];
    raw_message: string;
    font: number;
    sender: OneBotSender;
}

export interface OneBotGroupMessageEvent extends OneBotBaseEvent {
    post_type: 'message' | 'message_sent';
    message_type: 'group';
    sub_type: string;
    message_id: number;
    group_id: number;
    user_id: number;
    message: OneBotMessageSegment[];
    raw_message: string;
    font: number;
    sender: OneBotSender;
}

export interface OneBotMessageInfo {
    time: number;
    message_type: 'private' | 'group' | string;
    message_id: number;
    user_id: number;
    real_id?: number;
    sender: OneBotSender;
    message: OneBotMessageSegment[];
    raw_message?: string;
    [key: string]: unknown;
}

export type OneBotMessageEvent = OneBotPrivateMessageEvent | OneBotGroupMessageEvent;

export interface OneBotNoticeEvent extends OneBotBaseEvent {
    post_type: 'notice';
    notice_type: string;
}

export interface OneBotRequestEvent extends OneBotBaseEvent {
    post_type: 'request';
    request_type: string;
    flag: string;
    sub_type?: string;
    group_id?: number;
    user_id?: number;
    comment?: string;
}

export interface OneBotMetaEvent extends OneBotBaseEvent {
    post_type: 'meta_event';
    meta_event_type: string;
}

export type OneBotEvent = OneBotMessageEvent | OneBotNoticeEvent | OneBotRequestEvent | OneBotMetaEvent | OneBotBaseEvent;

export interface RequestOptions {
    echo?: OneBotEcho;
    timeoutMs?: number;
}

export interface ReconnectOptions {
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
}

export interface OneBotWebSocketClientOptions {
    url?: string;
    accessToken?: string;
    requestTimeoutMs?: number;
    reconnect?: boolean | ReconnectOptions;
}

type Handler<T> = (value: T) => void | Promise<void>;

interface PendingRequest {
    resolve: (response: ApiResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
}

export class OneBotApiError extends Error {
    constructor(public response: ApiResponse) {
        super(response.wording || `OneBot API 调用失败：${response.retcode}`);
    }
}

export class OneBotWebSocketClient {
    private url: string;
    private accessToken?: string;
    private requestTimeoutMs: number;
    private reconnect: ReconnectOptions | false;
    private socket: WebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private closedByUser = false;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pending = new Map<string, PendingRequest>();
    private eventHandlers = new Set<Handler<OneBotEvent>>();
    private rawHandlers = new Set<Handler<unknown>>();
    private openHandlers = new Set<Handler<void>>();
    private closeHandlers = new Set<Handler<{ code: number; reason: string }>>();
    private errorHandlers = new Set<Handler<unknown>>();

    constructor(options: OneBotWebSocketClientOptions = {}) {
        if (!globalThis.WebSocket) throw new Error('当前运行环境不支持标准 WebSocket');

        this.url = options.url ?? 'ws://127.0.0.1:3001/';
        this.accessToken = options.accessToken;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.reconnect = normalizeReconnect(options.reconnect);
    }

    get isConnected() {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    onOpen(handler: Handler<void>) {
        return addHandler(this.openHandlers, handler);
    }

    onClose(handler: Handler<{ code: number; reason: string }>) {
        return addHandler(this.closeHandlers, handler);
    }

    onError(handler: Handler<unknown>) {
        return addHandler(this.errorHandlers, handler);
    }

    emitError(error: unknown) {
        emit(this.errorHandlers, error);
    }

    onRaw(handler: Handler<unknown>) {
        return addHandler(this.rawHandlers, handler);
    }

    onEvent(handler: Handler<OneBotEvent>) {
        return addHandler(this.eventHandlers, handler);
    }

    onMessage(handler: Handler<OneBotMessageEvent>) {
        return this.onEvent((event) => {
            if (isMessageEvent(event)) return handler(event);
        });
    }

    onPrivateMessage(handler: Handler<OneBotPrivateMessageEvent>) {
        return this.onMessage((event) => {
            if (event.message_type === 'private') return handler(event);
        });
    }

    onGroupMessage(handler: Handler<OneBotGroupMessageEvent>) {
        return this.onMessage((event) => {
            if (event.message_type === 'group') return handler(event);
        });
    }

    async connect() {
        if (this.isConnected) return;
        if (this.connectPromise) return this.connectPromise;

        this.closedByUser = false;
        this.connectPromise = new Promise((resolve, reject) => {
            const socket = new WebSocket(withAccessToken(this.url, this.accessToken));
            this.socket = socket;

            // 连接成功后才认为客户端可用，未 open 前 close 会让 connect() 失败。
            socket.addEventListener('open', () => {
                this.reconnectAttempts = 0;
                this.connectPromise = null;
                emit(this.openHandlers, undefined);
                resolve();
            }, { once: true });

            socket.addEventListener('close', (event) => {
                if (this.connectPromise) reject(new Error('OneBot WebSocket 在连接建立前已关闭'));
                this.handleClose(event.code, event.reason);
            }, { once: true });

            socket.addEventListener('message', (event) => {
                this.handleMessage(event).catch((error) => emit(this.errorHandlers, error));
            });
            socket.addEventListener('error', (event) => emit(this.errorHandlers, event));
        });

        return this.connectPromise;
    }

    close(code = 1000, reason = 'normal') {
        this.closedByUser = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.rejectPending(new Error('OneBot WebSocket 客户端已关闭'));
        this.socket?.close(code, reason);
        this.socket = null;
        this.connectPromise = null;
    }

    async request<TData = unknown>(action: string, params: OneBotApiParams = {}, options: RequestOptions = {}) {
        await this.connect();

        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('OneBot WebSocket 未连接');
        }

        const echo = options.echo ?? `onebot:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const key = JSON.stringify(echo);
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

        // OneBot11 WebSocket API 通过 echo 把请求和响应关联起来。
        const response = new Promise<ApiResponse<TData>>((resolve, reject) => {
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    this.pending.delete(key);
                    reject(new Error(`OneBot 请求超时：${action}，等待 ${timeoutMs}ms 后仍未收到响应`));
                }, timeoutMs)
                : null;

            this.pending.set(key, { resolve: resolve as (response: ApiResponse) => void, reject, timer });
        });

        socket.send(JSON.stringify({ action, params, echo }));
        return response;
    }

    async call<TData = unknown>(action: string, params: OneBotApiParams = {}, options?: RequestOptions) {
        const response = await this.request<TData>(action, params, options);
        if (response.status !== 'ok' || response.retcode !== 0) throw new OneBotApiError(response);
        return response.data;
    }

    sendPrivateMessage(userId: number, message: OneBotMessage, options?: RequestOptions & { autoEscape?: boolean }) {
        return this.call<{ message_id: number }>('send_private_msg', {
            user_id: userId,
            message: normalizeMessage(message),
            auto_escape: options?.autoEscape,
        }, options);
    }

    sendGroupMessage(groupId: number, message: OneBotMessage, options?: RequestOptions & { autoEscape?: boolean }) {
        return this.call<{ message_id: number }>('send_group_msg', {
            group_id: groupId,
            message: normalizeMessage(message),
            auto_escape: options?.autoEscape,
        }, options);
    }

    getGroupMemberInfo(groupId: number, userId: number, options?: RequestOptions & { noCache?: boolean }) {
        return this.call<OneBotGroupMemberInfo>('get_group_member_info', {
            group_id: groupId,
            user_id: userId,
            no_cache: options?.noCache,
        }, options);
    }

    getStrangerInfo(userId: number, options?: RequestOptions & { noCache?: boolean }) {
        return this.call<OneBotStrangerInfo>('get_stranger_info', {
            user_id: userId,
            no_cache: options?.noCache,
        }, options);
    }

    getMessage(messageId: number, options?: RequestOptions) {
        return this.call<OneBotMessageInfo>('get_msg', {
            message_id: messageId,
        }, options);
    }

    private async handleMessage(event: MessageEvent) {
        const raw = await messageDataToString(event.data);
        emit(this.rawHandlers, raw);

        let packet: any;
        try {
            packet = JSON.parse(raw);
        } catch (error) {
            emit(this.errorHandlers, error);
            return;
        }

        // 带 echo 的包优先作为 API 响应处理，其他 post_type 包作为事件分发。
        if (packet?.echo !== undefined) {
            const pending = this.pending.get(JSON.stringify(packet.echo));
            if (pending) {
                if (pending.timer) clearTimeout(pending.timer);
                this.pending.delete(JSON.stringify(packet.echo));
                pending.resolve(packet);
                return;
            }
        }

        if (typeof packet?.post_type === 'string') {
            emit(this.eventHandlers, packet);
        }
    }

    private handleClose(code: number, reason: string) {
        this.socket = null;
        this.connectPromise = null;
        this.rejectPending(new Error('OneBot WebSocket 连接已关闭'));
        emit(this.closeHandlers, { code, reason });

        if (!this.closedByUser && this.reconnect) this.scheduleReconnect();
    }

    private scheduleReconnect() {
        if (this.reconnectTimer || !this.reconnect) return;
        if (this.reconnect.retries !== undefined && this.reconnectAttempts >= this.reconnect.retries) return;

        // 简单指数退避，避免连接断开后持续快速重试。
        const minDelayMs = this.reconnect.minDelayMs ?? 1000;
        const maxDelayMs = this.reconnect.maxDelayMs ?? 30_000;
        const delay = Math.min(maxDelayMs, minDelayMs * 2 ** this.reconnectAttempts);
        this.reconnectAttempts += 1;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((error) => {
                emit(this.errorHandlers, error);
                if (!this.closedByUser) this.scheduleReconnect();
            });
        }, delay);
    }

    private rejectPending(error: Error) {
        for (const request of this.pending.values()) {
            if (request.timer) clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
}

function addHandler<T>(handlers: Set<Handler<T>>, handler: Handler<T>) {
    handlers.add(handler);
    return () => handlers.delete(handler);
}

function emit<T>(handlers: Set<Handler<T>>, value: T) {
    for (const handler of handlers) {
        Promise.resolve(handler(value)).catch(() => undefined);
    }
}

function isMessageEvent(event: OneBotEvent): event is OneBotMessageEvent {
    return (event.post_type === 'message' || event.post_type === 'message_sent')
        && (event as any).message_type !== undefined;
}

function normalizeReconnect(reconnect?: boolean | ReconnectOptions) {
    if (!reconnect) return false;
    if (reconnect === true) return {};
    return reconnect;
}

function withAccessToken(url: string, accessToken?: string) {
    if (!accessToken) return url;

    const parsed = new URL(url);
    parsed.searchParams.set('access_token', accessToken);
    return parsed.toString();
}

async function messageDataToString(data: unknown) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (data instanceof Blob) return data.text();
    return String(data);
}

function normalizeMessage(message: OneBotMessage) {
    if (typeof message === 'string') return message;
    if (isMessageChainLike(message)) return message.toSegments();
    return Array.isArray(message) ? message : [message];
}

function isMessageChainLike(value: unknown): value is OneBotMessageChainLike {
    return typeof value === 'object'
        && value !== null
        && 'toSegments' in value
        && typeof (value as OneBotMessageChainLike).toSegments === 'function';
}
