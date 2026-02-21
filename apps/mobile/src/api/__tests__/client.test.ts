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

  it('createChat() forwards selected model to thread/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_model',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000000,
          status: { type: 'idle' },
          turns: [],
        },
      })
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_model',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000000,
          status: { type: 'idle' },
          turns: [],
        },
      });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    await client.createChat({ model: 'gpt-5.3-codex' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
      })
    );
  });

  it('sendChatMessage() forwards selected model/effort to turn/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_model' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_model',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: 'hello' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a1',
                  text: 'ok',
                },
              ],
            },
          ],
        },
      });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    await client.sendChatMessage('thr_model', {
      content: 'hello',
      model: 'gpt-5.3-codex',
      effort: 'high',
    });

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/resume', expect.any(Object));
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        effort: 'high',
      })
    );
  });

  it('listModels() maps model/list response', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'gpt-5.3-codex',
          displayName: 'GPT-5.3 Codex',
          description: 'Default coding model',
          hidden: false,
          supportsPersonality: true,
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Lower latency' },
            { reasoningEffort: 'medium', description: 'Balanced' },
            { reasoningEffort: 'high', description: 'Higher depth' },
          ],
        },
      ],
    });

    const client = new MacBridgeApiClient({ ws: ws as unknown as MacBridgeWsClient });
    const models = await client.listModels();

    expect(ws.request).toHaveBeenCalledWith(
      'model/list',
      expect.objectContaining({
        includeHidden: false,
      })
    );
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('gpt-5.3-codex');
    expect(models[0].isDefault).toBe(true);
    expect(models[0].defaultReasoningEffort).toBe('medium');
    expect(models[0].reasoningEffort?.map((option) => option.effort)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });
});
