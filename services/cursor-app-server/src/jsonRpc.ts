import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { CursorAppServer } from './appServer.js';

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcStdioServer {
  private readonly appServer: CursorAppServer;
  private readonly input: Readable;
  private readonly output: Writable;
  private readline: Interface | null = null;
  private unsubscribeNotifications: (() => void) | null = null;

  constructor(appServer: CursorAppServer, input: Readable, output: Writable) {
    this.appServer = appServer;
    this.input = input;
    this.output = output;
  }

  start(): void {
    if (this.readline) {
      return;
    }

    this.unsubscribeNotifications = this.appServer.onNotification((notification) => {
      this.write({
        jsonrpc: '2.0',
        method: notification.method,
        params: notification.params,
      });
    });

    this.readline = createInterface({
      input: this.input,
      crlfDelay: Infinity,
    });
    this.readline.on('line', (line) => {
      void this.handleLine(line);
    });
    this.readline.on('close', () => {
      this.stop();
    });
  }

  stop(): void {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = null;
    this.readline?.close();
    this.readline = null;
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      this.writeError(null, {
        code: -32700,
        message: 'parse error',
      });
      return;
    }

    if (!request.method || typeof request.method !== 'string') {
      this.writeError(request.id ?? null, {
        code: -32600,
        message: 'invalid JSON-RPC request',
      });
      return;
    }

    if (request.id === undefined || request.id === null) {
      return;
    }

    try {
      const result = await this.appServer.request(request.method, request.params);
      this.write({
        jsonrpc: '2.0',
        id: request.id,
        result,
      });
    } catch (error) {
      this.writeError(request.id, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private writeError(id: string | number | null, error: JsonRpcErrorPayload): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error,
    });
  }

  private write(payload: unknown): void {
    this.output.write(`${JSON.stringify(payload)}\n`);
  }
}
