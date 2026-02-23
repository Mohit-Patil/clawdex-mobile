import WebSocket, { type RawData } from 'ws';

import type { Logger } from './logger';
import type {
  BridgeNotification,
  BridgeRpcErrorPayload,
  BridgeRpcResponse,
} from './types';

interface BridgeClientOptions {
  url: string;
  authToken: string | null;
  requestTimeoutMs: number;
  logger: Logger;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private shouldRun = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: BridgeNotification) => void>();

  constructor(private readonly options: BridgeClientOptions) {}

  async start(): Promise<void> {
    this.shouldRun = true;
    await this.ensureConnected();
  }

  stop(): void {
    this.shouldRun = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }

    this.rejectAllPending(new Error('Bridge client stopped'));
  }

  onNotification(listener: (event: BridgeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Bridge websocket is not connected');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

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
        reject(new Error(`Bridge RPC timeout for method: ${method}`));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      socket.send(JSON.stringify(payload), (error?: Error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connectPromise = this.connect();
    this.connectPromise = connectPromise;

    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  private connect(): Promise<void> {
    const headers =
      this.options.authToken && this.options.authToken.length > 0
        ? { Authorization: `Bearer ${this.options.authToken}` }
        : undefined;

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers,
      });

      let settled = false;

      socket.once('open', () => {
        settled = true;
        this.socket = socket;
        this.reconnectAttempt = 0;
        this.options.logger.info('Connected to bridge websocket', {
          url: this.options.url,
        });
        resolve();
      });

      socket.on('message', (data: RawData) => {
        this.handleMessage(data.toString());
      });

      socket.once('error', (error: Error) => {
        this.options.logger.warn('Bridge websocket error', {
          message: error.message,
        });

        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.once('close', (code: number, reasonBuffer: Buffer) => {
        const reason = reasonBuffer.toString();

        if (!settled) {
          settled = true;
          reject(new Error(`Bridge websocket closed before open (${code}: ${reason})`));
        }

        this.handleSocketClosed(socket, code, reason);
      });
    });
  }

  private handleSocketClosed(socket: WebSocket, code: number, reason: string): void {
    if (this.socket === socket) {
      this.socket = null;
    }

    this.rejectAllPending(new Error(`Bridge websocket disconnected (${code}: ${reason})`));

    if (!this.shouldRun) {
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldRun) {
      return;
    }

    const delayMs = Math.min(10_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.options.logger.warn('Bridge websocket disconnected. Scheduling reconnect.', {
      delayMs,
      attempt: this.reconnectAttempt,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (!this.shouldRun) {
        return;
      }

      void this.ensureConnected().catch((error) => {
        this.options.logger.error('Bridge reconnect failed', {
          message: (error as Error).message,
        });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private handleMessage(raw: string): void {
    let parsed: BridgeRpcResponse;
    try {
      parsed = JSON.parse(raw) as BridgeRpcResponse;
    } catch (error) {
      this.options.logger.warn('Received invalid JSON from bridge websocket', {
        raw,
        error: (error as Error).message,
      });
      return;
    }

    if (typeof parsed.method === 'string') {
      this.emitNotification({
        method: parsed.method,
        params: parsed.params,
        eventId: parsed.eventId,
      });
      return;
    }

    if (typeof parsed.id !== 'number') {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(parsed.id);

    if (parsed.error) {
      pending.reject(toBridgeError(parsed.error));
      return;
    }

    pending.resolve(parsed.result);
  }

  private emitNotification(event: BridgeNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.warn('Bridge notification listener threw', {
          method: event.method,
          error: (error as Error).message,
        });
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.pending.clear();
  }
}

function toBridgeError(error: BridgeRpcErrorPayload): Error {
  const message =
    typeof error.message === 'string' && error.message.trim().length > 0
      ? error.message
      : 'Bridge RPC error';

  const wrapped = new Error(message);
  (wrapped as Error & { code?: number; data?: unknown }).code = error.code;
  (wrapped as Error & { code?: number; data?: unknown }).data = error.data;
  return wrapped;
}
