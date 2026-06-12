import {
    OneBotWebSocketClient,
    normalizeMessage,
    type ApiResponse,
    type OneBotApiParams,
    type OneBotEvent,
    type OneBotGroupMessageEvent,
    type OneBotMessage,
    type OneBotMessageEvent,
    type OneBotMessageSegment,
    type OneBotMetaEvent,
    type OneBotNoticeEvent,
    type OneBotPrivateMessageEvent,
    type OneBotRequestEvent,
    type OneBotSender,
    type OneBotWebSocketClientOptions,
    type RequestOptions,
} from './websocket-client';

type MessageInput = OneBotMessage;

/** 可能为 Promise 的联合类型 */
export type MaybePromise<T = void> = T | Promise<T>;
/** 中间件 next 函数 */
export type EventNext = () => Promise<void>;
/** 事件类型谓词 */
export type EventPredicate<TEvent extends OneBotEvent = OneBotEvent> = (event: OneBotEvent) => event is TEvent;
/** 事件处理器，接收事件和上下文 */
export type EventHandler<TEvent extends OneBotEvent = OneBotEvent> = (event: TEvent, ctx: OneBotEventContext<TEvent>) => MaybePromise;
/** 事件中间件，调用 next 将事件传递给下一个中间件 */
export type EventMiddleware = (event: OneBotEvent, ctx: OneBotEventContext, next: EventNext) => MaybePromise;

/** AI 角色信息 */
export interface AiCharacterInfo {
    character_id: string;
    character_name: string;
    preview_url: string;
}

/** AI 角色分组 */
export interface AiCharacterGroup {
    type: string;
    characters: AiCharacterInfo[];
}

/** 陌生人信息 */
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

/** 登录号信息 */
export interface OneBotLoginInfo {
    user_id: number;
    nickname: string;
}

/** 群成员信息 */
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

/** 历史消息信息 */
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

/** 请求处理选项（审批/拒绝） */
export interface RequestDecisionOptions extends RequestOptions {
    approve?: boolean;
    reason?: string;
    subType?: string;
}

/** 事件上下文，在事件处理器中通过 ctx 访问 */
export interface OneBotEventContext<TEvent extends OneBotEvent = OneBotEvent> {
    readonly event: TEvent;
    readonly client: OneBotClient;
    readonly stopped: boolean;
    stopPropagation(): void;
    reply(message: MessageInput, options?: RequestOptions & { autoEscape?: boolean }): Promise<unknown>;
    approve(options?: RequestDecisionOptions): Promise<unknown>;
    reject(reason?: string, options?: RequestDecisionOptions): Promise<unknown>;
    quickOperation(operation: OneBotApiParams, options?: RequestOptions): Promise<unknown>;
}

/** OneBot v11 业务客户端，基于 {@link OneBotWebSocketClient} 提供中间件事件系统和业务级 API */
export class OneBotClient {
    readonly ws: OneBotWebSocketClient;
    private middlewares: EventMiddleware[] = [];

    constructor(options: OneBotWebSocketClientOptions = {}) {
        this.ws = new OneBotWebSocketClient(options);
        this.ws.onEvent((event) => {
            this.dispatchEvent(event).catch((error) => this.ws.emitError(error));
        });
    }

    get isConnected() {
        return this.ws.isConnected;
    }

    connect() {
        return this.ws.connect();
    }

    close(code?: number, reason?: string) {
        return this.ws.close(code, reason);
    }

    onOpen(handler: (value: void) => MaybePromise) {
        return this.ws.onOpen(handler);
    }

    onClose(handler: (value: { code: number; reason: string }) => MaybePromise) {
        return this.ws.onClose(handler);
    }

    onError(handler: (value: unknown) => MaybePromise) {
        return this.ws.onError(handler);
    }

    onRaw(handler: (value: unknown) => MaybePromise) {
        return this.ws.onRaw(handler);
    }

    /** 原始 API 调用（不检查 status/retcode），同 websocket request */
    request<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<ApiResponse<TData>> {
        return this.ws.request(action, params, options);
    }

    /** API 调用（自动检查 status/retcode，失败抛 OneBotApiError） */
    call<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<TData> {
        return this.ws.call(action, params, options);
    }

    /** 调用任意 OneBot action（同 call） */
    raw<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<TData> {
        return this.call(action, params, options);
    }

    /** 调用任意 OneBot action，返回原始响应（同 request） */
    rawResponse<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<ApiResponse<TData>> {
        return this.request(action, params, options);
    }

    /** 发送私聊消息，返回 message_id */
    sendPrivateMessage(userId: number, message: MessageInput, options?: RequestOptions & { autoEscape?: boolean }) {
        return this.call<{ message_id: number }>('send_private_msg', {
            user_id: userId,
            message: normalizeMessage(message),
            auto_escape: options?.autoEscape,
        }, options);
    }

    /** 发送群聊消息，返回 message_id */
    sendGroupMessage(groupId: number, message: MessageInput, options?: RequestOptions & { autoEscape?: boolean }) {
        return this.call<{ message_id: number }>('send_group_msg', {
            group_id: groupId,
            message: normalizeMessage(message),
            auto_escape: options?.autoEscape,
        }, options);
    }

    /** 获取群成员信息 */
    getGroupMemberInfo(groupId: number, userId: number, options?: RequestOptions & { noCache?: boolean }): Promise<OneBotGroupMemberInfo> {
        return this.call<OneBotGroupMemberInfo>('get_group_member_info', {
            group_id: groupId,
            user_id: userId,
            no_cache: options?.noCache,
        }, options);
    }

    /** 获取陌生人信息 */
    getStrangerInfo(userId: number, options?: RequestOptions & { noCache?: boolean }): Promise<OneBotStrangerInfo> {
        return this.call<OneBotStrangerInfo>('get_stranger_info', {
            user_id: userId,
            no_cache: options?.noCache,
        }, options);
    }

    /** 获取当前登录号信息 */
    getLoginInfo(options?: RequestOptions): Promise<OneBotLoginInfo> {
        return this.call<OneBotLoginInfo>('get_login_info', {}, options);
    }

    /** 获取历史消息 */
    getMessage(messageId: number, options?: RequestOptions): Promise<OneBotMessageInfo> {
        return this.call<OneBotMessageInfo>('get_msg', {
            message_id: messageId,
        }, options);
    }

    /** 处理好友请求 */
    setFriendAddRequest(flag: string, approve = true, options?: RequestOptions & { remark?: string }) {
        return this.call<null>('set_friend_add_request', {
            flag,
            approve,
            remark: options?.remark,
        }, options);
    }

    /** 处理群请求 */
    setGroupAddRequest(flag: string, options: RequestDecisionOptions = {}) {
        return this.call<null>('set_group_add_request', {
            flag,
            sub_type: options.subType,
            approve: options.approve,
            reason: options.reason,
        }, options as RequestOptions);
    }

    /** 获取 AI 角色列表 */
    getAiCharacters(params: { group_id: string; chat_type?: string | number }, options?: RequestOptions): Promise<AiCharacterGroup[]> {
        return this.call<AiCharacterGroup[]>('get_ai_characters', params, options);
    }

    /** 调用 AI 语音引擎获取指定文本的语音 URL */
    getAiRecord(params: { character: string; group_id: string; text: string }, options?: RequestOptions): Promise<string> {
        return this.call<string>('get_ai_record', params, options);
    }

    /** 注册事件中间件，返回取消注册的函数 */
    use(middleware: EventMiddleware) {
        this.middlewares.push(middleware);
        return () => {
            const index = this.middlewares.indexOf(middleware);
            if (index >= 0) this.middlewares.splice(index, 1);
        };
    }

    /** 按条件注册事件处理器 */
    when<TEvent extends OneBotEvent>(predicate: EventPredicate<TEvent>, handler: EventHandler<TEvent>) {
        return this.use(async (event, ctx, next) => {
            if (predicate(event)) await handler(event, ctx as OneBotEventContext<TEvent>);
            if (!ctx.stopped) await next();
        });
    }

    /** 注册所有事件处理器 */
    onEvent(handler: EventHandler<OneBotEvent>) {
        return this.when(isAnyEvent, handler);
    }

    /** 注册消息事件处理器（私聊 + 群聊） */
    onMessage(handler: EventHandler<OneBotMessageEvent>) {
        return this.when(isMessageEvent, handler);
    }

    /** 注册私聊消息处理器 */
    onPrivateMessage(handler: EventHandler<OneBotPrivateMessageEvent>) {
        return this.when(isPrivateMessageEvent, handler);
    }

    /** 注册群聊消息处理器 */
    onGroupMessage(handler: EventHandler<OneBotGroupMessageEvent>) {
        return this.when(isGroupMessageEvent, handler);
    }

    /** 注册通知事件处理器，可指定 notice_type 过滤 */
    onNotice(handler: EventHandler<OneBotNoticeEvent>): () => void;
    onNotice(type: string, handler: EventHandler<OneBotNoticeEvent>): () => void;
    onNotice(typeOrHandler: string | EventHandler<OneBotNoticeEvent>, handler?: EventHandler<OneBotNoticeEvent>) {
        if (typeof typeOrHandler === 'string') {
            if (!handler) throw new Error('onNotice(type, handler) 需要传入 handler');
            return this.when((event): event is OneBotNoticeEvent => isNoticeEvent(event) && event.notice_type === typeOrHandler, handler);
        }

        return this.when(isNoticeEvent, typeOrHandler);
    }

    /** 注册请求事件处理器，可指定 request_type 过滤 */
    onRequest(handler: EventHandler<OneBotRequestEvent>): () => void;
    onRequest(type: string, handler: EventHandler<OneBotRequestEvent>): () => void;
    onRequest(typeOrHandler: string | EventHandler<OneBotRequestEvent>, handler?: EventHandler<OneBotRequestEvent>) {
        if (typeof typeOrHandler === 'string') {
            if (!handler) throw new Error('onRequest(type, handler) 需要传入 handler');
            return this.when((event): event is OneBotRequestEvent => isRequestEvent(event) && event.request_type === typeOrHandler, handler);
        }

        return this.when(isRequestEvent, typeOrHandler);
    }

    /** 注册 meta_event 处理器 */
    onMetaEvent(handler: EventHandler<OneBotMetaEvent>) {
        return this.when(isMetaEvent, handler);
    }

    private async dispatchEvent(event: OneBotEvent) {
        const ctx = createEventContext(event, this);
        let index = -1;

        const next = async () => {
            index += 1;
            const middleware = this.middlewares[index];
            if (!middleware || ctx.stopped) return;
            await middleware(event, ctx, next);
        };

        await next();
    }
}

function createEventContext<TEvent extends OneBotEvent>(event: TEvent, client: OneBotClient): OneBotEventContext<TEvent> {
    let stopped = false;

    return {
        event,
        client,
        get stopped() {
            return stopped;
        },
        stopPropagation() {
            stopped = true;
        },
        async reply(message, options) {
            if (isGroupMessageEvent(event)) return client.sendGroupMessage(event.group_id, message, options);
            if (isPrivateMessageEvent(event)) return client.sendPrivateMessage(event.user_id, message, options);
            throw new Error('reply() 只能在消息事件中使用');
        },
        async approve(options) {
            if (!isRequestEvent(event)) throw new Error('approve() 只能在请求事件中使用');
            if (event.request_type === 'friend') return client.setFriendAddRequest(event.flag, true, options);
            if (event.request_type === 'group') {
                return client.setGroupAddRequest(event.flag, {
                    ...options,
                    subType: options?.subType ?? event.sub_type,
                    approve: true,
                });
            }
            throw new Error(`approve() 不支持 request_type=${event.request_type}`);
        },
        async reject(reason, options) {
            if (!isRequestEvent(event)) throw new Error('reject() 只能在请求事件中使用');
            if (event.request_type === 'friend') return client.setFriendAddRequest(event.flag, false, options);
            if (event.request_type === 'group') {
                return client.setGroupAddRequest(event.flag, {
                    ...options,
                    subType: options?.subType ?? event.sub_type,
                    approve: false,
                    reason: reason ?? options?.reason,
                });
            }
            throw new Error(`reject() 不支持 request_type=${event.request_type}`);
        },
        quickOperation(operation, options) {
            return client.raw('.handle_quick_operation', { context: event, operation }, options);
        },
    };
}

function isAnyEvent(event: OneBotEvent): event is OneBotEvent {
    return typeof event.post_type === 'string';
}

function isMessageEvent(event: OneBotEvent): event is OneBotMessageEvent {
    return (event.post_type === 'message' || event.post_type === 'message_sent')
        && (event as OneBotMessageEvent).message_type !== undefined;
}

function isPrivateMessageEvent(event: OneBotEvent): event is OneBotPrivateMessageEvent {
    return isMessageEvent(event) && event.message_type === 'private';
}

function isGroupMessageEvent(event: OneBotEvent): event is OneBotGroupMessageEvent {
    return isMessageEvent(event) && event.message_type === 'group';
}

function isNoticeEvent(event: OneBotEvent): event is OneBotNoticeEvent {
    return event.post_type === 'notice' && typeof (event as OneBotNoticeEvent).notice_type === 'string';
}

function isRequestEvent(event: OneBotEvent): event is OneBotRequestEvent {
    return event.post_type === 'request'
        && typeof (event as OneBotRequestEvent).request_type === 'string'
        && typeof (event as OneBotRequestEvent).flag === 'string';
}

function isMetaEvent(event: OneBotEvent): event is OneBotMetaEvent {
    return event.post_type === 'meta_event' && typeof (event as OneBotMetaEvent).meta_event_type === 'string';
}
