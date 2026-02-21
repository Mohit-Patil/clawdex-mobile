import { Platform } from 'react-native';

import type { RpcNotification } from './types';

type EventListener = (event: RpcNotification) => void;
type StatusListener = (connected: boolean) => void;

interface MacBridgeWsClientOptions {
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

export class MacBridgeWsClient {
  private static readonly TURN_COMPLETION_TTL_MS = 5 * 60 * 1000;
  private socket: WebSocket | null = null;
  private connected = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;

  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly recentTurnCompletions = new Map<string, TurnCompletionSnapshot>();
  private readonly authToken: string | null;
  private readonly allowQueryTokenAuth: boolean;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private requestCounter = 0;

  constructor(baseUrl: string, options: MacBridgeWsClientOptions = {}) {
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

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`turn timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      const unsubscribe = this.onEvent((event) => {
        if (event.method !== 'turn/completed') {
          return;
        }

        const completion = toTurnCompletionSnapshot(event.params);
        if (!completion || completion.threadId !== threadId) {
          return;
        }

        const completedTurnId = completion.turnId;
        if (completedTurnId && completedTurnId !== turnId) {
          return;
        }

        const normalizedCompletion: TurnCompletionSnapshot = completedTurnId
          ? completion
          : {
              ...completion,
              turnId,
            };
        this.rememberTurnCompletion(normalizedCompletion);

        clearTimeout(timeout);
        unsubscribe();

        if (
          normalizedCompletion.status === 'failed' ||
          normalizedCompletion.status === 'interrupted'
        ) {
          reject(
            new Error(
              normalizedCompletion.errorMessage ??
                `turn ${normalizedCompletion.status ?? 'failed'}`
            )
          );
          return;
        }

        resolve();
      });
    });
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
      if (String(record.method) === 'turn/completed') {
        const completion = toTurnCompletionSnapshot(record.params);
        if (completion?.turnId) {
          this.rememberTurnCompletion(completion);
        }
      }

      this.emitEvent({
        method: String(record.method),
        params: toRecord(record.params),
      });
    }
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
      if (now - snapshot.completedAt > MacBridgeWsClient.TURN_COMPLETION_TTL_MS) {
        this.recentTurnCompletions.delete(key);
      }
    }
  }

  private assertTurnSucceeded(snapshot: TurnCompletionSnapshot): void {
    if (snapshot.status === 'failed' || snapshot.status === 'interrupted') {
      throw new Error(snapshot.errorMessage ?? `turn ${snapshot.status ?? 'failed'}`);
    }
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
