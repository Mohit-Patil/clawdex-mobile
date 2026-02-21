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

  it('listChats() maps app-server list response', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_1',
          preview: 'hello world',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'active' },
          turns: [
            {
              status: 'completed',
              items: [],
            },
          ],
        },
      ],
    });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const chats = await client.listChats();

    expect(ws.request).toHaveBeenCalledWith(
      'thread/list',
      expect.objectContaining({
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      })
    );
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe('thr_1');
    expect(chats[0].status).toBe('complete');
  });

  it('listChats() treats idle thread status as complete even with stale inProgress turn', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_idle_with_stale_turn',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          turns: [
            {
              status: 'inProgress',
              items: [],
            },
          ],
        },
      ],
    });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const chats = await client.listChats();

    expect(chats).toHaveLength(1);
    expect(chats[0].status).toBe('complete');
  });

  it('listChats() excludes sub-agent source kinds defensively', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_root',
          preview: 'root chat',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          source: 'appServer',
          turns: [],
        },
        {
          id: 'thr_sub',
          preview: 'spawned worker',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: 'thr_root',
                depth: 1,
              },
            },
          },
          turns: [],
        },
        {
          id: 'thr_sub_legacy',
          preview: 'legacy sub-agent',
          createdAt: 1700000000,
          updatedAt: 1700000003,
          status: { type: 'idle' },
          source: { kind: 'subAgent' },
          turns: [],
        },
      ],
    });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const chats = await client.listChats();

    expect(chats.map((chat) => chat.id)).toEqual(['thr_root']);
  });

  it('sendChatMessage() starts a turn and waits for completion', async () => {
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
    const chat = await client.sendChatMessage('thr_1', { content: 'Hello' });

    expect(ws.request).toHaveBeenNthCalledWith(2, 'turn/start', expect.any(Object));
    expect(ws.waitForTurnCompletion).toHaveBeenCalledWith('thr_1', 'turn_1');
    expect(chat.id).toBe('thr_1');
    expect(chat.messages.length).toBeGreaterThan(0);
  });
});
