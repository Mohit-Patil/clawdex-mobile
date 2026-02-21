import { Platform } from 'react-native';

import { MacBridgeWsClient } from '../ws';

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send = jest.fn();
  close = jest.fn();
  readyState = 1;

  simulateOpen() {
    this.onopen?.();
  }

  simulateClose() {
    this.onclose?.();
  }

  simulateError() {
    this.onerror?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

let mockInstances: MockWebSocket[];

function latestMockSocket(): MockWebSocket {
  return mockInstances[mockInstances.length - 1];
}

beforeEach(() => {
  mockInstances = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).WebSocket = jest.fn(() => {
    const ws = new MockWebSocket();
    mockInstances.push(ws);
    return ws;
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).WebSocket;
});

describe('MacBridgeWsClient', () => {
  it('connect() builds /rpc websocket URL', () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    client.connect();

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc');
  });

  it('sends Authorization header on native when auth token is provided', () => {
    const client = new MacBridgeWsClient('http://localhost:8787', {
      authToken: 'token-abc',
    });
    client.connect();

    if (Platform.OS === 'web') {
      expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc');
      return;
    }

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc', undefined, {
      headers: { Authorization: 'Bearer token-abc' },
    });
  });

  it('supports web query token auth fallback when enabled', () => {
    if (Platform.OS !== 'web') {
      return;
    }

    const client = new MacBridgeWsClient('http://localhost:8787', {
      authToken: 'token-xyz',
      allowQueryTokenAuth: true,
    });
    client.connect();

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc?token=token-xyz');
  });

  it('onEvent emits rpc notifications', () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    latestMockSocket().simulateMessage(
      JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_1' } })
    );

    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      params: { threadId: 'thr_1' },
    });
  });

  it('request() resolves using JSON-RPC response id', async () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();

    const requestPromise = client.request<{ ok: boolean }>('bridge/health/read');
    await Promise.resolve();

    const sentPayload = JSON.parse(String(socket.send.mock.calls[0][0])) as {
      id: string;
      method: string;
    };

    expect(sentPayload.method).toBe('bridge/health/read');

    socket.simulateMessage(
      JSON.stringify({
        id: sentPayload.id,
        result: { ok: true },
      })
    );

    await expect(requestPromise).resolves.toEqual({ ok: true });
  });

  it('onStatus emits open/close state changes', () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onStatus(listener);
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();
    client.disconnect();

    expect(listener).toHaveBeenNthCalledWith(1, true);
    expect(listener).toHaveBeenNthCalledWith(2, false);
  });

  it('waitForTurnCompletion resolves from cached completion events', async () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    client.connect();

    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );

    await expect(client.waitForTurnCompletion('thr_1', 'turn_1', 100)).resolves.toBeUndefined();
  });

  it('waitForTurnCompletion accepts snake_case completion payloads', async () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    client.connect();

    const waitPromise = client.waitForTurnCompletion('thr_2', 'turn_2', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          thread_id: 'thr_2',
          turn_id: 'turn_2',
          status: 'completed',
        },
      })
    );

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('waitForTurnCompletion tolerates completion payloads without turn id', async () => {
    const client = new MacBridgeWsClient('http://localhost:8787');
    client.connect();

    const waitPromise = client.waitForTurnCompletion('thr_3', 'turn_3', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thr_3',
          status: 'completed',
        },
      })
    );

    await expect(waitPromise).resolves.toBeUndefined();
  });
});
