import type { BridgeWsEvent } from './types';

type EventListener = (event: BridgeWsEvent) => void;

type StatusListener = (connected: boolean) => void;

export class MacBridgeWsClient {
  private socket: WebSocket | null = null;
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(private readonly url: string) {}

  connect(): void {
    if (this.socket) {
      return;
    }

    const socket = new WebSocket(this.url);

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
    for (const listener of this.statusListeners) {
      listener(connected);
    }
  }
}
