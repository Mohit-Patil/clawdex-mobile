import { Platform } from 'react-native';

import type { BridgeWsEvent } from './types';

type EventListener = (event: BridgeWsEvent) => void;

type StatusListener = (connected: boolean) => void;

interface MacBridgeWsClientOptions {
  authToken?: string | null;
  allowQueryTokenAuth?: boolean;
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

export class MacBridgeWsClient {
  private socket: WebSocket | null = null;
  private connected = false;
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly authToken: string | null;
  private readonly allowQueryTokenAuth: boolean;

  constructor(
    private readonly url: string,
    options: MacBridgeWsClientOptions = {}
  ) {
    this.authToken = options.authToken?.trim() || null;
    this.allowQueryTokenAuth = options.allowQueryTokenAuth ?? false;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.socket) {
      return;
    }

    const WebSocketCtor =
      globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor;
    const socketUrl = this.socketUrl();
    const socket =
      this.authToken && Platform.OS !== 'web'
        ? new WebSocketCtor(socketUrl, undefined, {
            headers: {
              Authorization: `Bearer ${this.authToken}`
            }
          })
        : new WebSocketCtor(socketUrl);

    socket.onopen = () => {
      this.emitStatus(true);
    };

    socket.onclose = () => {
      this.socket = null;
      this.emitStatus(false);
    };

    socket.onerror = () => {
      this.emitStatus(false);
    };

    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as BridgeWsEvent;
        if (parsed && typeof parsed.type === 'string') {
          this.emitEvent(parsed);
        }
      } catch {
        // Ignore malformed payloads from server.
      }
    };

    this.socket = socket;
  }

  disconnect(): void {
    if (!this.socket) {
      return;
    }

    this.socket.close();
    this.socket = null;
    this.emitStatus(false);
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

  private emitEvent(event: BridgeWsEvent): void {
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
    if (!this.authToken || Platform.OS !== 'web' || !this.allowQueryTokenAuth) {
      return this.url;
    }

    const separator = this.url.includes('?') ? '&' : '?';
    return `${this.url}${separator}token=${encodeURIComponent(this.authToken)}`;
  }
}
