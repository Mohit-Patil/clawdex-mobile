import { Platform } from 'react-native';

import type { RpcNotification } from './types';

type EventListener = (event: RpcNotification) => void;
type StatusListener = (connected: boolean) => void;

interface HostBridgeWsClientOptions {
  authToken?: string | null;
  allowQueryTokenAuth?: boolean;
  requestTimeoutMs?: number;
}

interface ReactNativeWebSocketConstructor {
  new (
    url: string,
    protocols?: string | string[],
    options?: {
      headers?: Record<string, string>;
    }
  ): WebSocket;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface TurnCompletionSnapshot {
  threadId: string;
  turnId: string | null;
  status: string | null;
  errorMessage: string | null;
  completedAt: number;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface ReplayEventsResponse {
  events?: unknown[];
  hasMore?: boolean;
  earliestEventId?: number;
  latestEventId?: number;
}

export class HostBridgeWsClient {
  private static readonly TURN_COMPLETION_TTL_MS = 5 * 60 * 1000;
  private static readonly RECENT_EVENT_ID_CACHE_SIZE = 4096;
  private socket: WebSocket | null = null;
  private connected = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;

  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly recentTurnCompletions = new Map<string, TurnCompletionSnapshot>();
  private readonly recentEventIds = new Set<number>();
  private readonly recentEventIdQueue: number[] = [];
  private readonly pendingTurnWaits = new Set<string>();
  private readonly authToken: string | null;
  private readonly allowQueryTokenAuth: boolean;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private lastSeenEventId = 0;
  private replaySupported = true;
  private replayInFlight: Promise<void> | null = null;
  private requestCounter = 0;

  constructor(baseUrl: string, options: HostBridgeWsClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = options.authToken?.trim() || null;
    this.allowQueryTokenAuth = options.allowQueryTokenAuth ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    this.shouldReconnect = true;
    if (this.socket || this.connectPromise) {
      return;
    }

    const promise = this.openSocket();
    this.connectPromise = promise;
    void promise.catch(() => {
      // Connection errors are surfaced through status listeners and retries.
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (!this.socket) {
      this.emitStatus(false);
      return;
    }

    this.socket.close();
    this.socket = null;
    this.emitStatus(false);
    this.rejectAllPending(new Error('Bridge websocket disconnected'));
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();

    const id = `${Date.now()}-${++this.requestCounter}`;
    const payload: Record<string, unknown> = {
      id,
      method,
    };

    if (params !== undefined) {
      payload.params = params;
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new Error('Bridge websocket is not connected');
    }

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for method: ${method}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    const cachedCompletion = this.getTurnCompletion(threadId, turnId);
    if (cachedCompletion) {
      this.assertTurnSucceeded(cachedCompletion);
      return;
    }

    const waitKey = turnCompletionKey(threadId, turnId);
    this.pendingTurnWaits.add(waitKey);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (result: { ok: true } | { ok: false; error: Error }) => {
          clearTimeout(timeout);
          unsubscribe();
          if (result.ok) {
            resolve();
            return;
          }
          reject(result.error);
        };

        const timeout = setTimeout(() => {
          finish({ ok: false, error: new Error(`turn timed out after ${String(timeoutMs)}ms`) });
        }, timeoutMs);

        const unsubscribe = this.onEvent((event) => {
          const canUseUnscopedEvent = this.canUseUnscopedTurnEvent(waitKey);

          if (event.method.startsWith('codex/event/')) {
            const codexEvent = toCodexEventSnapshot(event.method, event.params);
            if (!codexEvent) {
              return;
            }

            const isMatchingThread = codexEvent.threadId === threadId;
            const isUnscopedMatch = codexEvent.threadId === null && canUseUnscopedEvent;
            if (!isMatchingThread && !isUnscopedMatch) {
              return;
            }

            if (CODEX_TURN_ABORT_EVENT_TYPES.has(codexEvent.type)) {
              finish({ ok: false, error: new Error('turn aborted') });
              return;
            }

            if (CODEX_TURN_FAILURE_EVENT_TYPES.has(codexEvent.type)) {
              finish({ ok: false, error: new Error(`turn failed (${codexEvent.type})`) });
              return;
            }

            if (CODEX_TURN_COMPLETE_EVENT_TYPES.has(codexEvent.type)) {
              finish({ ok: true });
              return;
            }
          }

          if (event.method !== 'turn/completed') {
            return;
          }

          let normalizedCompletion: TurnCompletionSnapshot | null = null;
          const completion = toTurnCompletionSnapshot(event.params);
          if (completion) {
            if (completion.threadId !== threadId) {
              return;
            }

            if (completion.turnId && completion.turnId !== turnId) {
              return;
            }

            normalizedCompletion = completion.turnId
              ? completion
              : {
                  ...completion,
                  turnId,
                };
          } else if (canUseUnscopedEvent) {
            const unscopedCompletion = toUnscopedTurnCompletionSnapshot(event.params);
            if (!unscopedCompletion) {
              return;
            }

            if (unscopedCompletion.turnId && unscopedCompletion.turnId !== turnId) {
              return;
            }

            normalizedCompletion = {
              threadId,
              turnId: unscopedCompletion.turnId ?? turnId,
              status: unscopedCompletion.status,
              errorMessage: unscopedCompletion.errorMessage,
              completedAt: unscopedCompletion.completedAt,
            };
          }

          if (!normalizedCompletion) {
            return;
          }

          this.rememberTurnCompletion(normalizedCompletion);
          if (isFailedTurnStatus(normalizedCompletion.status)) {
            finish({
              ok: false,
              error: new Error(
                normalizedCompletion.errorMessage ??
                  `turn ${normalizedCompletion.status ?? 'failed'}`
              ),
            });
            return;
          }

          finish({ ok: true });
        });
      });
    } finally {
      this.pendingTurnWaits.delete(waitKey);
    }
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);

    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket?.readyState === 1) {
      return;
    }

    this.connect();
    if (this.connectPromise) {
      await this.connectPromise;
    }

    if (!this.connected || this.socket?.readyState !== 1) {
      throw new Error('Unable to connect to bridge websocket');
    }
  }

  private async openSocket(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const WebSocketCtor = globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor;
        const socketUrl = this.socketUrl();
        const socket =
          this.authToken && Platform.OS !== 'web'
            ? new WebSocketCtor(socketUrl, undefined, {
                headers: {
                  Authorization: `Bearer ${this.authToken}`,
                },
              })
            : new WebSocketCtor(socketUrl);

        let settled = false;

        socket.onopen = () => {
          settled = true;
          this.socket = socket;
          this.reconnectAttempts = 0;
          this.emitStatus(true);
          if (this.lastSeenEventId > 0) {
            this.scheduleReplay();
          }
          resolve();
        };

        socket.onclose = () => {
          this.socket = null;
          this.emitStatus(false);
          this.rejectAllPending(new Error('Bridge websocket closed'));

          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }

          if (!settled) {
            settled = true;
            reject(new Error('Bridge websocket closed before open'));
          }
        };

        socket.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error('Bridge websocket error'));
          }
        };

        socket.onmessage = (message) => {
          this.handleIncoming(String(message.data));
        };
      });
    } finally {
      this.connectPromise = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.socket || this.connectPromise) {
      return;
    }

    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;

    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(5000, 500 * 2 ** attempt) + jitter;

    setTimeout(() => {
      if (!this.shouldReconnect || this.socket || this.connectPromise) {
        return;
      }
      const promise = this.openSocket();
      this.connectPromise = promise;
      void promise.catch(() => {
        // Retried connect failures are handled by subsequent retries.
      });
    }, delay);
  }

  private handleIncoming(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const record = toRecord(parsed);
    if (!record) {
      return;
    }

    const hasMethod = typeof record.method === 'string';
    const hasId = typeof record.id === 'string' || typeof record.id === 'number';

    if (hasId) {
      const pending = this.pendingRequests.get(record.id as string | number);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(record.id as string | number);

      const error = toRecord(record.error) as RpcError | null;
      if (error && typeof error.message === 'string') {
        pending.reject(new Error(`RPC ${String(error.code)}: ${error.message}`));
        return;
      }

      pending.resolve(record.result ?? null);
      return;
    }

    if (hasMethod) {
      this.handleNotificationRecord(record);
    }
  }

  private handleNotificationRecord(
    record: Record<string, unknown>,
    options?: {
      replayFloorEventId?: number;
    }
  ): void {
    const method = readString(record.method);
    if (!method) {
      return;
    }

    const params = toRecord(record.params);
    const eventId = readEventId(record);
    if (eventId !== null) {
      // Bridge restarts reset event IDs; treat that as a new stream.
      if (eventId === 1 && this.lastSeenEventId > 1) {
        this.lastSeenEventId = 0;
        this.clearRecentEventIdCache();
      }

      const replayFloorEventId = options?.replayFloorEventId ?? null;
      if (replayFloorEventId !== null) {
        if (eventId <= replayFloorEventId) {
          return;
        }
      } else if (eventId <= this.lastSeenEventId) {
        return;
      }

      if (this.recentEventIds.has(eventId)) {
        return;
      }
      this.markEventIdSeen(eventId);

      if (eventId > this.lastSeenEventId) {
        this.lastSeenEventId = eventId;
      }
    }

    if (method === 'turn/completed') {
      const completion = toTurnCompletionSnapshot(params);
      if (completion?.turnId) {
        this.rememberTurnCompletion(completion);
      }
    }

    const event: RpcNotification = {
      method,
      params,
    };
    if (eventId !== null) {
      event.eventId = eventId;
    }
    this.emitEvent(event);
  }

  private scheduleReplay(): void {
    if (!this.replaySupported) {
      return;
    }
    if (this.replayInFlight) {
      return;
    }
    if (!this.connected || !this.socket || this.socket.readyState !== 1) {
      return;
    }

    this.replayInFlight = this.replayMissedEvents()
      .catch(() => {
        // Replay is best-effort; live WS stream continues regardless.
      })
      .finally(() => {
        this.replayInFlight = null;
      });
  }

  private async replayMissedEvents(): Promise<void> {
    if (!this.replaySupported || this.lastSeenEventId <= 0) {
      return;
    }

    let cursor = this.lastSeenEventId;
    const maxPages = 10;
    for (let page = 0; page < maxPages; page += 1) {
      let response: ReplayEventsResponse;
      try {
        response = await this.request<ReplayEventsResponse>('bridge/events/replay', {
          afterEventId: cursor,
          limit: 200,
        });
      } catch (error) {
        const message = String((error as Error).message ?? error).toLowerCase();
        if (
          message.includes('rpc -32601') ||
          message.includes('unknown bridge method: bridge/events/replay')
        ) {
          this.replaySupported = false;
          return;
        }
        throw error;
      }

      const latestEventId = readNumber(response.latestEventId);
      if (latestEventId !== null && latestEventId < cursor) {
        this.lastSeenEventId = 0;
        this.clearRecentEventIdCache();
        return;
      }

      const events = Array.isArray(response.events) ? response.events : [];
      for (const entry of events) {
        const record = toRecord(entry);
        if (!record) {
          continue;
        }
        this.handleNotificationRecord(record, {
          replayFloorEventId: cursor,
        });
      }

      const hasMore = response.hasMore === true;
      if (!hasMore) {
        return;
      }

      if (this.lastSeenEventId <= cursor) {
        return;
      }
      cursor = this.lastSeenEventId;
    }
  }

  private markEventIdSeen(eventId: number): void {
    this.recentEventIds.add(eventId);
    this.recentEventIdQueue.push(eventId);
    while (
      this.recentEventIdQueue.length > HostBridgeWsClient.RECENT_EVENT_ID_CACHE_SIZE
    ) {
      const removed = this.recentEventIdQueue.shift();
      if (typeof removed === 'number') {
        this.recentEventIds.delete(removed);
      }
    }
  }

  private clearRecentEventIdCache(): void {
    this.recentEventIds.clear();
    this.recentEventIdQueue.length = 0;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private getTurnCompletion(threadId: string, turnId: string): TurnCompletionSnapshot | null {
    this.pruneTurnCompletions();
    return this.recentTurnCompletions.get(turnCompletionKey(threadId, turnId)) ?? null;
  }

  private rememberTurnCompletion(snapshot: TurnCompletionSnapshot): void {
    if (!snapshot.turnId) {
      return;
    }

    this.pruneTurnCompletions();
    this.recentTurnCompletions.set(
      turnCompletionKey(snapshot.threadId, snapshot.turnId),
      snapshot
    );
  }

  private pruneTurnCompletions(): void {
    const now = Date.now();
    for (const [key, snapshot] of this.recentTurnCompletions.entries()) {
      if (now - snapshot.completedAt > HostBridgeWsClient.TURN_COMPLETION_TTL_MS) {
        this.recentTurnCompletions.delete(key);
      }
    }
  }

  private assertTurnSucceeded(snapshot: TurnCompletionSnapshot): void {
    if (isFailedTurnStatus(snapshot.status)) {
      throw new Error(snapshot.errorMessage ?? `turn ${snapshot.status ?? 'failed'}`);
    }
  }

  private canUseUnscopedTurnEvent(waitKey: string): boolean {
    return this.pendingTurnWaits.size === 1 && this.pendingTurnWaits.has(waitKey);
  }

  private emitEvent(event: RpcNotification): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private emitStatus(connected: boolean): void {
    this.connected = connected;
    for (const listener of this.statusListeners) {
      listener(connected);
    }
  }

  private socketUrl(): string {
    const wsBase = this.baseUrl.startsWith('https://')
      ? this.baseUrl.replace('https://', 'wss://')
      : this.baseUrl.replace('http://', 'ws://');
    const base = `${wsBase}/rpc`;

    if (!this.authToken || Platform.OS !== 'web' || !this.allowQueryTokenAuth) {
      return base;
    }

    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}token=${encodeURIComponent(this.authToken)}`;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function readEventId(record: Record<string, unknown>): number | null {
  const eventId = readNumber(record.eventId) ?? readNumber(record.event_id);
  if (eventId === null || eventId < 1) {
    return null;
  }
  return eventId;
}

function turnCompletionKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

function toTurnCompletionSnapshot(value: unknown): TurnCompletionSnapshot | null {
  const params = toRecord(value);
  if (!params) {
    return null;
  }

  const threadId = readString(params.threadId) ?? readString(params.thread_id);
  const turn = toRecord(params.turn);
  const turnId =
    readString(turn?.id) ?? readString(params.turnId) ?? readString(params.turn_id);
  if (!threadId) {
    return null;
  }

  const turnError = toRecord(turn?.error) ?? toRecord(params.error);

  return {
    threadId,
    turnId,
    status: readString(turn?.status) ?? readString(params.status),
    errorMessage: readString(turnError?.message),
    completedAt: Date.now(),
  };
}

function toUnscopedTurnCompletionSnapshot(
  value: unknown
): Omit<TurnCompletionSnapshot, 'threadId'> | null {
  const params = toRecord(value);
  if (!params) {
    return null;
  }

  const turn = toRecord(params.turn);
  const turnId =
    readString(turn?.id) ?? readString(params.turnId) ?? readString(params.turn_id);
  const status = readString(turn?.status) ?? readString(params.status);
  const turnError = toRecord(turn?.error) ?? toRecord(params.error);
  const errorMessage = readString(turnError?.message);

  if (!turnId && !status && !errorMessage) {
    return null;
  }

  return {
    turnId: turnId ?? null,
    status: status ?? null,
    errorMessage: errorMessage ?? null,
    completedAt: Date.now(),
  };
}

function toCodexEventSnapshot(
  method: string,
  value: unknown
): { type: string; threadId: string | null } | null {
  if (!method.startsWith('codex/event/')) {
    return null;
  }

  const params = toRecord(value);
  const msg = toRecord(params?.msg);
  const rawType = readString(msg?.type) ?? method.replace('codex/event/', '');
  const type = normalizeCodexEventType(rawType);
  if (!type) {
    return null;
  }

  const threadId =
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(params?.threadId) ??
    readString(params?.thread_id) ??
    readString(params?.conversationId) ??
    readString(msg?.conversation_id);

  return {
    type,
    threadId,
  };
}

function normalizeCodexEventType(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

const CODEX_TURN_COMPLETE_EVENT_TYPES = new Set(['task_complete', 'taskcomplete']);
const CODEX_TURN_ABORT_EVENT_TYPES = new Set([
  'turn_aborted',
  'turnaborted',
  'task_interrupted',
  'taskinterrupted',
]);
const CODEX_TURN_FAILURE_EVENT_TYPES = new Set([
  'task_failed',
  'taskfailed',
  'turn_failed',
  'turnfailed',
]);

function isFailedTurnStatus(status: string | null): boolean {
  return (
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'error' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}
