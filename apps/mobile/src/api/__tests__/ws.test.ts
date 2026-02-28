import { Platform } from 'react-native';

import { HostBridgeWsClient } from '../ws';

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

describe('HostBridgeWsClient', () => {
  it('connect() builds /rpc websocket URL', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc');
  });

  it('sends Authorization header on native when auth token is provided', () => {
    const client = new HostBridgeWsClient('http://localhost:8787', {
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

    const client = new HostBridgeWsClient('http://localhost:8787', {
      authToken: 'token-xyz',
      allowQueryTokenAuth: true,
    });
    client.connect();

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc?token=token-xyz');
  });

  it('onEvent emits rpc notifications', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
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
    const client = new HostBridgeWsClient('http://localhost:8787');
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
    const client = new HostBridgeWsClient('http://localhost:8787');
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
    const client = new HostBridgeWsClient('http://localhost:8787');
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
    const client = new HostBridgeWsClient('http://localhost:8787');
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
    const client = new HostBridgeWsClient('http://localhost:8787');
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

  it('waitForTurnCompletion resolves from codex task_complete event', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    const waitPromise = client.waitForTurnCompletion('thr_4', 'turn_4', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'codex/event/task_complete',
        params: {
          msg: {
            type: 'task_complete',
            thread_id: 'thr_4',
          },
        },
      })
    );

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('waitForTurnCompletion resolves from codex event using source parent_thread_id', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    const waitPromise = client.waitForTurnCompletion('thr_5', 'turn_5', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'codex/event/task_complete',
        params: {
          msg: {
            type: 'task_complete',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'thr_5',
                },
              },
            },
          },
        },
      })
    );

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('deduplicates notifications by eventId', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 5,
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 5,
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 4,
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      eventId: 5,
      params: {
        threadId: 'thr_1',
        turn: {
          id: 'turn_1',
          status: 'completed',
        },
      },
    });
  });

  it('requests replay from latest event id after reconnect', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 10,
        params: {
          threadId: 'thr_9',
          turnId: 'turn_9',
        },
      })
    );

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    await Promise.resolve();

    const replayRequest = secondSocket.send.mock.calls
      .map((call) =>
        JSON.parse(String(call[0])) as {
          id: string;
          method: string;
          params?: {
            afterEventId?: number;
          };
        }
      )
      .find((payload) => payload.method === 'bridge/events/replay');

    expect(replayRequest).toBeDefined();
    expect(replayRequest?.params?.afterEventId).toBe(10);

    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          events: [
            {
              method: 'turn/completed',
              eventId: 11,
              params: {
                threadId: 'thr_9',
                turn: {
                  id: 'turn_9',
                  status: 'completed',
                },
              },
            },
          ],
          hasMore: false,
        },
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      eventId: 11,
      params: {
        threadId: 'thr_9',
        turn: {
          id: 'turn_9',
          status: 'completed',
        },
      },
    });
  });

  it('replays missed events without duplicating live events received after reconnect', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 100,
        params: {
          threadId: 'thr_gap',
          turnId: 'turn_gap',
        },
      })
    );
    listener.mockClear();

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    await Promise.resolve();

    const replayRequest = secondSocket.send.mock.calls
      .map((call) =>
        JSON.parse(String(call[0])) as {
          id: string;
          method: string;
          params?: {
            afterEventId?: number;
          };
        }
      )
      .find((payload) => payload.method === 'bridge/events/replay');
    expect(replayRequest).toBeDefined();
    expect(replayRequest?.params?.afterEventId).toBe(100);

    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 105,
        params: {
          threadId: 'thr_gap',
          turnId: 'turn_gap',
        },
      })
    );
    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 106,
        params: {
          threadId: 'thr_gap',
          turn: {
            id: 'turn_gap',
            status: 'completed',
          },
        },
      })
    );

    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          events: [
            {
              method: 'turn/started',
              eventId: 101,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 102,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 103,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 104,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 105,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/completed',
              eventId: 106,
              params: {
                threadId: 'thr_gap',
                turn: {
                  id: 'turn_gap',
                  status: 'completed',
                },
              },
            },
          ],
          hasMore: false,
        },
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    const eventIds = listener.mock.calls
      .map((call) => (call[0] as { eventId?: number }).eventId)
      .filter((id): id is number => typeof id === 'number');

    expect(eventIds).toEqual(expect.arrayContaining([101, 102, 103, 104, 105, 106]));
    expect(eventIds.filter((id) => id === 105)).toHaveLength(1);
    expect(eventIds.filter((id) => id === 106)).toHaveLength(1);
  });

  it('accepts new events after bridge event counter reset', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    firstSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 10,
        params: {
          threadId: 'thr_reset',
          turnId: 'turn_a',
        },
      })
    );

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    await Promise.resolve();

    const replayRequest = secondSocket.send.mock.calls
      .map((call) =>
        JSON.parse(String(call[0])) as {
          id: string;
          method: string;
        }
      )
      .find((payload) => payload.method === 'bridge/events/replay');
    expect(replayRequest).toBeDefined();

    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          events: [],
          hasMore: false,
          latestEventId: 2,
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 2,
        params: {
          threadId: 'thr_reset',
          turn: {
            id: 'turn_a',
            status: 'completed',
          },
        },
      })
    );

    expect(listener).toHaveBeenLastCalledWith({
      method: 'turn/completed',
      eventId: 2,
      params: {
        threadId: 'thr_reset',
        turn: {
          id: 'turn_a',
          status: 'completed',
        },
      },
    });
  });
});
