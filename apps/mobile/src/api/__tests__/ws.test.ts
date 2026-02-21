import { MacBridgeWsClient } from '../ws';
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  close = jest.fn();

  // Test helpers
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mockInstances: MockWebSocket[];

function latestMockSocket(): MockWebSocket {
  return mockInstances[mockInstances.length - 1];
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_URL = 'ws://localhost:9000';

describe('MacBridgeWsClient', () => {
  // -- connect() -----------------------------------------------------------

  describe('connect()', () => {
    it('creates a WebSocket with the given URL', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      client.connect();

      expect(global.WebSocket).toHaveBeenCalledWith(TEST_URL);
      expect(mockInstances).toHaveLength(1);
    });

    it('is idempotent - calling twice does not create a second socket', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      client.connect();
      client.connect();

      expect(global.WebSocket).toHaveBeenCalledTimes(1);
      expect(mockInstances).toHaveLength(1);
    });

    it('sends Authorization header options when auth token is set on native', () => {
      const client = new MacBridgeWsClient(TEST_URL, { authToken: 'token-abc' });
      client.connect();

      if (Platform.OS === 'web') {
        expect(global.WebSocket).toHaveBeenCalledWith(TEST_URL);
        return;
      }

      expect(global.WebSocket).toHaveBeenCalledWith(TEST_URL, undefined, {
        headers: { Authorization: 'Bearer token-abc' },
      });
    });

    it('supports web query-token fallback when explicitly enabled', () => {
      if (Platform.OS !== 'web') {
        return;
      }

      const client = new MacBridgeWsClient(TEST_URL, {
        authToken: 'token-xyz',
        allowQueryTokenAuth: true,
      });
      client.connect();

      expect(global.WebSocket).toHaveBeenCalledWith(`${TEST_URL}?token=token-xyz`);
    });
  });

  // -- disconnect() --------------------------------------------------------

  describe('disconnect()', () => {
    it('calls socket.close() and nulls reference so next connect() creates new socket', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      client.connect();

      const firstSocket = latestMockSocket();
      client.disconnect();

      expect(firstSocket.close).toHaveBeenCalledTimes(1);

      // A subsequent connect() should create a brand-new socket
      client.connect();
      expect(mockInstances).toHaveLength(2);
    });

    it('is safe when not connected (no error thrown)', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  // -- onEvent -------------------------------------------------------------

  describe('onEvent', () => {
    it('listener receives parsed BridgeWsEvent when onmessage fires with valid JSON', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      const listener = jest.fn();
      client.onEvent(listener);
      client.connect();

      const payload = {
        type: 'health',
        payload: { status: 'ok', at: '2024-01-01T00:00:00Z' },
      };

      latestMockSocket().simulateMessage(JSON.stringify(payload));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it('does not throw or emit to listeners on malformed JSON', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      const listener = jest.fn();
      client.onEvent(listener);
      client.connect();

      expect(() => {
        latestMockSocket().simulateMessage('not json');
      }).not.toThrow();

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not emit to listeners when JSON is missing the type field', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      const listener = jest.fn();
      client.onEvent(listener);
      client.connect();

      latestMockSocket().simulateMessage(JSON.stringify({ foo: 'bar' }));

      expect(listener).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function that removes the listener', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      const listener = jest.fn();
      const unsubscribe = client.onEvent(listener);
      client.connect();

      const event = {
        type: 'health',
        payload: { status: 'ok', at: '2024-01-01T00:00:00Z' },
      };

      // First message should be received
      latestMockSocket().simulateMessage(JSON.stringify(event));
      expect(listener).toHaveBeenCalledTimes(1);

      // After unsubscribe, listener should no longer receive events
      unsubscribe();
      latestMockSocket().simulateMessage(JSON.stringify(event));
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // -- onStatus ------------------------------------------------------------

  describe('onStatus', () => {
    it('listener receives true on socket open, false on socket close', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      const listener = jest.fn();
      client.onStatus(listener);
      client.connect();

      latestMockSocket().simulateOpen();
      expect(listener).toHaveBeenCalledWith(true);

      latestMockSocket().simulateClose();
      expect(listener).toHaveBeenCalledWith(false);

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('returns an unsubscribe function that removes the listener', () => {
      const client = new MacBridgeWsClient(TEST_URL);
      const listener = jest.fn();
      const unsubscribe = client.onStatus(listener);
      client.connect();

      // Listener should receive the open event
      latestMockSocket().simulateOpen();
      expect(listener).toHaveBeenCalledTimes(1);

      // After unsubscribe, listener should no longer receive status changes
      unsubscribe();
      latestMockSocket().simulateClose();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
