export interface RpcNotification {
  method: string;
  params?: unknown;
  eventId?: number;
}

interface RpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
  eventId?: number;
}

interface BridgeClientOptions {
  wsUrl: string;
  authToken: string | null;
  allowQueryTokenAuth: boolean;
  requestTimeoutMs: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export class BridgeClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(event: RpcNotification) => void>();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();

  constructor(private readonly options: BridgeClientOptions) {}

  start(): void {
    this.shouldReconnect = true;
    if (!this.socket && !this.connectPromise) {
      void this.ensureConnected();
    }
  }

  stop(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.emitConnectionState('disconnected');
    this.rejectPending(new Error('Bridge client stopped'));
  }

  onNotification(listener: (event: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Bridge websocket not connected');
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload: Record<string, unknown> = {
      id,
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const promise = this.connect();
    this.connectPromise = promise;

    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  private connect(): Promise<void> {
    this.emitConnectionState('connecting');
    const wsUrl = this.buildWsUrl();

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      let settled = false;

      socket.addEventListener('open', () => {
        settled = true;
        this.socket = socket;
        this.reconnectAttempt = 0;
        this.emitConnectionState('connected');
        resolve();
      });

      socket.addEventListener('message', (event) => {
        this.handleMessage(event.data);
      });

      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('Bridge websocket connection failed'));
        }
      });

      socket.addEventListener('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('Bridge websocket closed before connecting'));
        }

        if (this.socket === socket) {
          this.socket = null;
        }

        this.emitConnectionState('disconnected');
        this.rejectPending(new Error('Bridge websocket disconnected'));

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delayMs = Math.min(10000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) {
        return;
      }
      void this.ensureConnected();
    }, delayMs);
  }

  private handleMessage(rawData: unknown): void {
    if (typeof rawData !== 'string') {
      return;
    }

    let payload: RpcResponse;
    try {
      payload = JSON.parse(rawData) as RpcResponse;
    } catch {
      return;
    }

    if (typeof payload.method === 'string') {
      const event: RpcNotification = {
        method: payload.method,
        params: payload.params,
        eventId: typeof payload.eventId === 'number' ? payload.eventId : undefined,
      };
      this.emitNotification(event);
      return;
    }

    if (typeof payload.id !== 'number') {
      return;
    }

    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(payload.id);

    if (payload.error) {
      pending.reject(new Error(payload.error.message ?? 'Bridge RPC error'));
      return;
    }

    pending.resolve(payload.result);
  }

  private emitNotification(event: RpcNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(event);
      } catch {
        // Listener errors should not break notification delivery.
      }
    }
  }

  private emitConnectionState(state: ConnectionState): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(state);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private buildWsUrl(): string {
    const base = this.options.wsUrl;
    const token = this.options.authToken;

    if (!token) {
      return base;
    }

    if (!this.options.allowQueryTokenAuth) {
      return base;
    }

    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}token=${encodeURIComponent(token)}`;
  }
}
