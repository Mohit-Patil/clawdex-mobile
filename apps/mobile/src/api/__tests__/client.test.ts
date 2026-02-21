import { MacBridgeApiClient } from '../client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body: unknown, status = 200) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = mockFetchResponse({ status: 'ok' });
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('MacBridgeApiClient - constructor', () => {
  it('strips trailing slash from baseUrl', async () => {
    const client = new MacBridgeApiClient({ baseUrl: 'http://localhost:8787/' });
    await client.health();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:8787/health');
  });
});

// ---------------------------------------------------------------------------
// wsUrl()
// ---------------------------------------------------------------------------

describe('MacBridgeApiClient - wsUrl()', () => {
  it('converts http to ws and appends /ws', () => {
    const client = new MacBridgeApiClient({ baseUrl: 'http://localhost:8787' });
    expect(client.wsUrl()).toBe('ws://localhost:8787/ws');
  });

  it('converts https to wss and appends /ws', () => {
    const client = new MacBridgeApiClient({ baseUrl: 'https://example.com' });
    expect(client.wsUrl()).toBe('wss://example.com/ws');
  });

  it('handles IP address with port and no trailing slash', () => {
    const client = new MacBridgeApiClient({ baseUrl: 'http://192.168.1.30:8787' });
    expect(client.wsUrl()).toBe('ws://192.168.1.30:8787/ws');
  });

  it('does not append auth token to websocket query params', () => {
    const client = new MacBridgeApiClient({
      baseUrl: 'http://localhost:8787',
      authToken: 'super-secret-token',
    });
    expect(client.wsUrl()).toBe('ws://localhost:8787/ws');
  });
});

// ---------------------------------------------------------------------------
// Request methods
// ---------------------------------------------------------------------------

describe('MacBridgeApiClient - request methods', () => {
  const BASE = 'http://localhost:8787';
  let client: MacBridgeApiClient;

  beforeEach(() => {
    client = new MacBridgeApiClient({ baseUrl: BASE });
  });

  it('health() sends GET to /health with correct headers', async () => {
    const body = { status: 'ok', at: '2025-01-01T00:00:00Z', uptimeSec: 42 };
    global.fetch = mockFetchResponse(body);

    const result = await client.health();

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/health`);
    expect(init.method).toBeUndefined(); // default GET has no explicit method
    expect(init.headers).toEqual(
      expect.objectContaining({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      })
    );
    expect(result).toEqual(body);
  });

  it('listThreads() sends GET to /threads', async () => {
    const threads = [{ id: '1', title: 'Thread 1' }];
    global.fetch = mockFetchResponse(threads);

    const result = await client.listThreads();

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/threads`);
    expect(result).toEqual(threads);
  });

  it('createThread() sends POST to /threads with JSON body', async () => {
    const thread = { id: '1', title: 'New Thread', messages: [] };
    global.fetch = mockFetchResponse(thread);

    const result = await client.createThread({ title: 'New Thread', message: 'Hello' });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/threads`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'New Thread',
      message: 'Hello',
    });
    expect(result).toEqual(thread);
  });

  it('throws on non-ok response with status code and body in message', async () => {
    const errorBody = { error: 'Internal Server Error' };
    global.fetch = mockFetchResponse(errorBody, 500);

    await expect(client.health()).rejects.toThrow('HTTP 500');
    // Verify body is included in the error message
    global.fetch = mockFetchResponse(errorBody, 500);
    await expect(client.health()).rejects.toThrow(JSON.stringify(errorBody));
  });

  it('returns parsed JSON on success', async () => {
    const data = { status: 'ok', at: '2025-06-01T00:00:00Z', uptimeSec: 100 };
    global.fetch = mockFetchResponse(data);

    const result = await client.health();
    expect(result).toEqual(data);
  });

  it('adds Authorization header when auth token is configured', async () => {
    const authClient = new MacBridgeApiClient({
      baseUrl: BASE,
      authToken: 'token-123',
    });
    global.fetch = mockFetchResponse({ status: 'ok', at: '2025-01-01T00:00:00Z', uptimeSec: 1 });

    await authClient.health();

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer token-123',
      })
    );
  });
});
