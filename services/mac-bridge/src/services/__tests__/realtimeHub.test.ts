import { RealtimeHub } from '../realtimeHub';
import type { BridgeWsEvent } from '../../types';
import type { WebSocket } from '@fastify/websocket';

// ---------------------------------------------------------------------------
// Mock WebSocket client helper
// ---------------------------------------------------------------------------

interface MockClient {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _triggerClose: () => void;
}

function createMockClient(readyState = 1): MockClient {
  const handlers: Record<string, () => void> = {};
  return {
    readyState,
    send: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      handlers[event] = handler;
    }),
    // Helper to trigger close event in tests
    _triggerClose: () => handlers['close']?.(),
  };
}

// ---------------------------------------------------------------------------
// RealtimeHub
// ---------------------------------------------------------------------------

describe('RealtimeHub', () => {
  const sampleEvent: BridgeWsEvent = {
    type: 'health',
    payload: { status: 'ok', at: '2026-01-01T00:00:00.000Z' },
  };

  it('broadcast sends serialized JSON to all connected clients with readyState === 1', () => {
    const hub = new RealtimeHub();
    const client1 = createMockClient(1);
    const client2 = createMockClient(1);

    hub.addClient(client1 as unknown as WebSocket);
    hub.addClient(client2 as unknown as WebSocket);
    hub.broadcast(sampleEvent);

    const expected = JSON.stringify(sampleEvent);
    expect(client1.send).toHaveBeenCalledTimes(1);
    expect(client1.send).toHaveBeenCalledWith(expected);
    expect(client2.send).toHaveBeenCalledTimes(1);
    expect(client2.send).toHaveBeenCalledWith(expected);
  });

  it('broadcast skips clients where readyState !== 1 (e.g., CLOSED)', () => {
    const hub = new RealtimeHub();
    const openClient = createMockClient(1);
    const closedClient = createMockClient(3); // WebSocket.CLOSED = 3

    hub.addClient(openClient as unknown as WebSocket);
    hub.addClient(closedClient as unknown as WebSocket);
    hub.broadcast(sampleEvent);

    expect(openClient.send).toHaveBeenCalledTimes(1);
    expect(closedClient.send).not.toHaveBeenCalled();
  });

  it('addClient registers a client; after triggering close, client is removed and no longer receives broadcasts', () => {
    const hub = new RealtimeHub();
    const client = createMockClient(1);

    hub.addClient(client as unknown as WebSocket);

    // Verify the close handler was registered
    expect(client.on).toHaveBeenCalledWith('close', expect.any(Function));

    // Client should receive broadcasts before close
    hub.broadcast(sampleEvent);
    expect(client.send).toHaveBeenCalledTimes(1);

    // Trigger close -- client should be removed
    client._triggerClose();

    // Reset mock to verify no further calls
    client.send.mockClear();
    hub.broadcast(sampleEvent);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('broadcast on empty hub does nothing (no errors thrown)', () => {
    const hub = new RealtimeHub();

    expect(() => hub.broadcast(sampleEvent)).not.toThrow();
  });

  it('multiple clients each receive the same broadcast payload', () => {
    const hub = new RealtimeHub();
    const clients = [
      createMockClient(1),
      createMockClient(1),
      createMockClient(1),
    ];

    for (const client of clients) {
      hub.addClient(client as unknown as WebSocket);
    }

    hub.broadcast(sampleEvent);

    const expected = JSON.stringify(sampleEvent);
    for (const client of clients) {
      expect(client.send).toHaveBeenCalledTimes(1);
      expect(client.send).toHaveBeenCalledWith(expected);
    }
  });
});
