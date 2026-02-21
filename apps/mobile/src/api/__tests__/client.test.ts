import { MacBridgeApiClient } from '../client';
import type { MacBridgeWsClient } from '../ws';

function createWsMock() {
  type WsLike = Pick<MacBridgeWsClient, 'request' | 'waitForTurnCompletion'>;
  return {
    request: jest.fn(),
    waitForTurnCompletion: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<WsLike>;
}

describe('MacBridgeApiClient', () => {
  it('health() calls bridge/health/read', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ status: 'ok', at: '2026-01-01T00:00:00Z', uptimeSec: 10 });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const result = await client.health();

    expect(ws.request).toHaveBeenCalledWith('bridge/health/read');
    expect(result.status).toBe('ok');
  });

  it('listThreads() maps app-server list response', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_1',
          preview: 'hello world',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          turns: [],
        },
      ],
    });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const threads = await client.listThreads();

    expect(ws.request).toHaveBeenCalledWith('thread/list', expect.any(Object));
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('thr_1');
  });

  it('sendThreadMessage() starts a turn and waits for completion', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_1' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_1',
          preview: 'final',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: 'Hello' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a1',
                  text: 'Hi there',
                },
              ],
            },
          ],
        },
      });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const thread = await client.sendThreadMessage('thr_1', { content: 'Hello' });

    expect(ws.request).toHaveBeenNthCalledWith(2, 'turn/start', expect.any(Object));
    expect(ws.waitForTurnCompletion).toHaveBeenCalledWith('thr_1', 'turn_1');
    expect(thread.id).toBe('thr_1');
    expect(thread.messages.length).toBeGreaterThan(0);
  });
});
