import {
    OneBotWebSocketClient,
    type ApiResponse,
    type OneBotApiParams,
    type OneBotEvent,
    type OneBotGroupMessageEvent,
    type OneBotGroupMemberInfo,
    type OneBotMessageEvent,
    type OneBotMessageInfo,
    type OneBotMetaEvent,
    type OneBotNoticeEvent,
    type OneBotPrivateMessageEvent,
    type OneBotRequestEvent,
    type OneBotStrangerInfo,
    type OneBotWebSocketClientOptions,
    type RequestOptions,
} from './websocket-client';

type MessageInput = Parameters<OneBotWebSocketClient['sendPrivateMessage']>[1];

export type MaybePromise<T = void> = T | Promise<T>;
export type EventNext = () => Promise<void>;
export type EventPredicate<TEvent extends OneBotEvent = OneBotEvent> = (event: OneBotEvent) => event is TEvent;
export type EventHandler<TEvent extends OneBotEvent = OneBotEvent> = (event: TEvent, ctx: OneBotEventContext<TEvent>) => MaybePromise;
export type EventMiddleware = (event: OneBotEvent, ctx: OneBotEventContext, next: EventNext) => MaybePromise;

export interface RequestDecisionOptions extends RequestOptions {
    approve?: boolean;
    reason?: string;
    subType?: string;
}

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

    request<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<ApiResponse<TData>> {
        return this.ws.request(action, params, options);
    }

    call<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<TData> {
        return this.ws.call(action, params, options);
    }

    raw<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<TData> {
        return this.call(action, params, options);
    }

    rawResponse<TData = unknown>(action: string, params?: OneBotApiParams, options?: RequestOptions): Promise<ApiResponse<TData>> {
        return this.request(action, params, options);
    }

    sendPrivateMessage(userId: number, message: MessageInput, options?: RequestOptions & { autoEscape?: boolean }) {
        return this.ws.sendPrivateMessage(userId, message, options);
    }

    sendGroupMessage(groupId: number, message: MessageInput, options?: RequestOptions & { autoEscape?: boolean }) {
        return this.ws.sendGroupMessage(groupId, message, options);
    }

    getGroupMemberInfo(groupId: number, userId: number, options?: RequestOptions & { noCache?: boolean }): Promise<OneBotGroupMemberInfo> {
        return this.ws.getGroupMemberInfo(groupId, userId, options);
    }

    getStrangerInfo(userId: number, options?: RequestOptions & { noCache?: boolean }): Promise<OneBotStrangerInfo> {
        return this.ws.getStrangerInfo(userId, options);
    }

    getMessage(messageId: number, options?: RequestOptions): Promise<OneBotMessageInfo> {
        return this.ws.getMessage(messageId, options);
    }

    setFriendAddRequest(flag: string, approve = true, options?: RequestOptions & { remark?: string }) {
        return this.call<null>('set_friend_add_request', {
            flag,
            approve,
            remark: options?.remark,
        }, options);
    }

    setGroupAddRequest(flag: string, options: RequestDecisionOptions = {}) {
        return this.call<null>('set_group_add_request', {
            flag,
            sub_type: options.subType,
            approve: options.approve,
            reason: options.reason,
        }, options as RequestOptions);
    }

    use(middleware: EventMiddleware) {
        this.middlewares.push(middleware);
        return () => {
            const index = this.middlewares.indexOf(middleware);
            if (index >= 0) this.middlewares.splice(index, 1);
        };
    }

    when<TEvent extends OneBotEvent>(predicate: EventPredicate<TEvent>, handler: EventHandler<TEvent>) {
        return this.use(async (event, ctx, next) => {
            if (predicate(event)) await handler(event, ctx as OneBotEventContext<TEvent>);
            if (!ctx.stopped) await next();
        });
    }

    onEvent(handler: EventHandler<OneBotEvent>) {
        return this.when(isAnyEvent, handler);
    }

    onMessage(handler: EventHandler<OneBotMessageEvent>) {
        return this.when(isMessageEvent, handler);
    }

    onPrivateMessage(handler: EventHandler<OneBotPrivateMessageEvent>) {
        return this.when(isPrivateMessageEvent, handler);
    }

    onGroupMessage(handler: EventHandler<OneBotGroupMessageEvent>) {
        return this.when(isGroupMessageEvent, handler);
    }

    onNotice(handler: EventHandler<OneBotNoticeEvent>): () => void;
    onNotice(type: string, handler: EventHandler<OneBotNoticeEvent>): () => void;
    onNotice(typeOrHandler: string | EventHandler<OneBotNoticeEvent>, handler?: EventHandler<OneBotNoticeEvent>) {
        if (typeof typeOrHandler === 'string') {
            if (!handler) throw new Error('onNotice(type, handler) 需要传入 handler');
            return this.when((event): event is OneBotNoticeEvent => isNoticeEvent(event) && event.notice_type === typeOrHandler, handler);
        }

        return this.when(isNoticeEvent, typeOrHandler);
    }

    onRequest(handler: EventHandler<OneBotRequestEvent>): () => void;
    onRequest(type: string, handler: EventHandler<OneBotRequestEvent>): () => void;
    onRequest(typeOrHandler: string | EventHandler<OneBotRequestEvent>, handler?: EventHandler<OneBotRequestEvent>) {
        if (typeof typeOrHandler === 'string') {
            if (!handler) throw new Error('onRequest(type, handler) 需要传入 handler');
            return this.when((event): event is OneBotRequestEvent => isRequestEvent(event) && event.request_type === typeOrHandler, handler);
        }

        return this.when(isRequestEvent, typeOrHandler);
    }

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
