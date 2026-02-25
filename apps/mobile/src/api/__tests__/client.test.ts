import { HostBridgeApiClient } from '../client';
import type { HostBridgeWsClient } from '../ws';

function createWsMock() {
  type WsLike = Pick<HostBridgeWsClient, 'request' | 'waitForTurnCompletion'>;
  return {
    request: jest.fn(),
    waitForTurnCompletion: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<WsLike>;
}

describe('HostBridgeApiClient', () => {
  it('health() calls bridge/health/read', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ status: 'ok', at: '2026-01-01T00:00:00Z', uptimeSec: 10 });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chats = await client.listChats();

    expect(chats.map((chat) => chat.id)).toEqual(['thr_root']);
  });

  it('sendChatMessage() starts a turn without waiting for completion', async () => {
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
              id: 'turn_1',
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chat = await client.sendChatMessage('thr_1', { content: 'Hello' });

    expect(ws.request).toHaveBeenNthCalledWith(2, 'turn/start', expect.any(Object));
    expect(ws.waitForTurnCompletion).not.toHaveBeenCalled();
    expect(chat.id).toBe('thr_1');
    expect(chat.messages.length).toBeGreaterThan(0);
  });

  it('sendChatMessage() retries thread/read until sent user message is materialized', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      ws.request
        .mockResolvedValueOnce({}) // thread/resume
        .mockResolvedValueOnce({ turn: { id: 'turn_retry' } }) // turn/start
        .mockResolvedValueOnce({
          thread: {
            id: 'thr_retry',
            preview: 'stale',
            createdAt: 1700000000,
            updatedAt: 1700000001,
            status: { type: 'idle' },
            turns: [],
          },
        }) // stale thread/read (missing latest user item)
        .mockResolvedValueOnce({
          thread: {
            id: 'thr_retry',
            preview: 'Hello',
            createdAt: 1700000000,
            updatedAt: 1700000002,
            status: { type: 'idle' },
              turns: [
                {
                  id: 'turn_retry',
                  items: [
                    {
                      type: 'userMessage',
                      id: 'u_retry',
                    content: [{ type: 'text', text: 'Hello' }],
                  },
                ],
              },
            ],
          },
        }); // retried thread/read

      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const chatPromise = client.sendChatMessage('thr_retry', { content: 'Hello' });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(200);
      const chat = await chatPromise;

      expect(chat.messages.some((message) => message.role === 'user' && message.content === 'Hello')).toBe(true);
      expect(ws.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thr_retry',
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('sendChatMessage() keeps a repeated user prompt when the new turn is missing from thread/read', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      const staleReadResponse = {
        thread: {
          id: 'thr_repeat',
          preview: 'repeat',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_old',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_old_repeat',
                  content: [{ type: 'text', text: 'repeat' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a_old_repeat',
                  text: 'old answer',
                },
              ],
            },
          ],
        },
      };

      ws.request
        .mockResolvedValueOnce({}) // thread/resume
        .mockResolvedValueOnce({ turn: { id: 'turn_new_repeat' } }) // turn/start
        .mockResolvedValue(staleReadResponse); // thread/read retries always stale

      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const chatPromise = client.sendChatMessage('thr_repeat', { content: 'repeat' });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2_000);
      const chat = await chatPromise;

      const repeatedUserMessages = chat.messages.filter(
        (message) => message.role === 'user' && message.content === 'repeat'
      );
      expect(repeatedUserMessages.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ model: 'gpt-5.3-codex' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
      })
    );
  });

  it('createChat() forwards selected approval policy to thread/start', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_policy',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ approvalPolicy: 'never' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        approvalPolicy: 'never',
      })
    );
  });

  it('renameChat() retries with threadName when name payload is rejected', async () => {
    const ws = createWsMock();
    ws.request
      .mockRejectedValueOnce(new Error('missing field `threadName`'))
      .mockResolvedValueOnce({}) // thread/name/set retry with threadName
      .mockResolvedValueOnce({}) // explicit threadName attempt
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_rename',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          name: 'Renamed Chat',
          turns: [],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const renamed = await client.renameChat('thr_rename', 'Renamed Chat');

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/name/set', {
      threadId: 'thr_rename',
      name: 'Renamed Chat',
    });
    expect(ws.request).toHaveBeenNthCalledWith(2, 'thread/name/set', {
      threadId: 'thr_rename',
      threadName: 'Renamed Chat',
    });
    expect(ws.request).toHaveBeenNthCalledWith(3, 'thread/name/set', {
      threadId: 'thr_rename',
      threadName: 'Renamed Chat',
    });
    expect(renamed.title).toBe('Renamed Chat');
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
              id: 'turn_model',
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
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

  it('sendChatMessage() forwards selected approval policy to resume and turn/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_policy' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_policy_turn',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_policy',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_policy',
                  content: [{ type: 'text', text: 'hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_policy_turn', {
      content: 'hello',
      approvalPolicy: 'never',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({
        approvalPolicy: 'never',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        approvalPolicy: 'never',
      })
    );
  });

  it('resumeThread() retries with compatibility payload when modern resume params are rejected', async () => {
    const ws = createWsMock();
    ws.request
      .mockRejectedValueOnce(new Error('unknown field `experimentalRawEvents`'))
      .mockResolvedValueOnce({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.resumeThread('thr_resume')).resolves.toBeUndefined();

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume',
        experimentalRawEvents: true,
        approvalPolicy: 'untrusted',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume',
        approvalPolicy: 'on-request',
        developerInstructions: expect.any(String),
        experimentalRawEvents: true,
      })
    );
  });

  it('resumeThread() falls back to legacy payload when compatibility retry is rejected', async () => {
    const ws = createWsMock();
    ws.request
      .mockRejectedValueOnce(new Error('unknown field `experimentalRawEvents`'))
      .mockRejectedValueOnce(new Error('invalid params for resume options'))
      .mockResolvedValueOnce({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.resumeThread('thr_resume_legacy')).resolves.toBeUndefined();

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume_legacy',
        experimentalRawEvents: true,
        approvalPolicy: 'untrusted',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume_legacy',
        approvalPolicy: 'on-request',
        developerInstructions: expect.any(String),
        experimentalRawEvents: true,
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      3,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume_legacy',
        approvalPolicy: 'on-request',
        developerInstructions: null,
      })
    );

    const legacyPayload = ws.request.mock.calls[2]?.[1] as Record<string, unknown>;
    expect(legacyPayload).not.toHaveProperty('experimentalRawEvents');
  });

  it('resumeThread() keeps never approval policy in legacy retry when explicitly requested', async () => {
    const ws = createWsMock();
    ws.request
      .mockRejectedValueOnce(new Error('unknown field `experimentalRawEvents`'))
      .mockResolvedValueOnce({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(
      client.resumeThread('thr_resume_never', { approvalPolicy: 'never' })
    ).resolves.toBeUndefined();

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume_never',
        approvalPolicy: 'never',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume_never',
        approvalPolicy: 'never',
      })
    );
  });

  it('sendChatMessage() forwards mention and local-image attachments to turn/start input', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_mentions' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_mentions',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_mentions',
              items: [
                {
                  type: 'userMessage',
              id: 'u_mentions',
              content: [{ type: 'text', text: 'review these files' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_mentions', {
      content: 'review these files',
      mentions: [
        { path: 'apps/mobile/src/screens/MainScreen.tsx' },
        { path: 'apps/mobile/src/api/client.ts', name: 'client.ts' },
      ],
      localImages: [{ path: '.clawdex-mobile-attachments/example.png' }],
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: 'review these files',
          }),
          expect.objectContaining({
            type: 'mention',
            path: 'apps/mobile/src/screens/MainScreen.tsx',
            name: 'MainScreen.tsx',
          }),
          expect.objectContaining({
            type: 'mention',
            path: 'apps/mobile/src/api/client.ts',
            name: 'client.ts',
          }),
          expect.objectContaining({
            type: 'localImage',
            path: '.clawdex-mobile-attachments/example.png',
          }),
        ]),
      })
    );
  });

  it('uploadAttachment() calls bridge/attachments/upload', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      path: '.clawdex-mobile-attachments/file.txt',
      fileName: 'file.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      kind: 'file',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const uploaded = await client.uploadAttachment({
      dataBase64: 'aGVsbG8=',
      fileName: 'file.txt',
      mimeType: 'text/plain',
      kind: 'file',
    });

    expect(ws.request).toHaveBeenCalledWith('bridge/attachments/upload', {
      dataBase64: 'aGVsbG8=',
      fileName: 'file.txt',
      mimeType: 'text/plain',
      kind: 'file',
    });
    expect(uploaded.path).toBe('.clawdex-mobile-attachments/file.txt');
  });

  it('interruptTurn() calls turn/interrupt with thread and turn id', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.interruptTurn('thr_stop', 'turn_stop');

    expect(ws.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thr_stop',
      turnId: 'turn_stop',
    });
  });

  it('interruptLatestTurn() resolves and interrupts the latest active turn', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_active',
          preview: 'working',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'active' },
          turns: [
            {
              id: 'turn_done',
              status: 'completed',
              items: [],
            },
            {
              id: 'turn_live',
              status: 'inProgress',
              items: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const turnId = await client.interruptLatestTurn('thr_active');

    expect(turnId).toBe('turn_live');
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'thr_active',
      includeTurns: true,
    });
    expect(ws.request).toHaveBeenNthCalledWith(2, 'turn/interrupt', {
      threadId: 'thr_active',
      turnId: 'turn_live',
    });
  });

  it('interruptLatestTurn() returns null when there is no active turn', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_idle',
        preview: 'done',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn_done',
            status: 'completed',
            items: [],
          },
        ],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const turnId = await client.interruptLatestTurn('thr_idle');

    expect(turnId).toBeNull();
    expect(ws.request).toHaveBeenCalledTimes(1);
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'thr_idle',
      includeTurns: true,
    });
  });

  it('sendChatMessage() sends structured collaborationMode for plan mode', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_plan' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_plan',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_plan',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_plan',
                  content: [{ type: 'text', text: 'hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_plan', {
      content: 'hello',
      model: 'gpt-5.3-codex',
      effort: 'high',
      collaborationMode: 'plan',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        effort: 'high',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.3-codex',
            reasoning_effort: 'high',
            developer_instructions: null,
          },
        },
      })
    );
  });

  it('sendChatMessage() resolves default model before plan mode turn when model is unset', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5.3-codex',
            displayName: 'GPT-5.3 Codex',
            isDefault: true,
          },
        ],
      }) // model/list fallback
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_plan_fallback' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_plan_fallback',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_plan_fallback',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_plan_fallback',
                  content: [{ type: 'text', text: 'hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_plan_fallback', {
      content: 'hello',
      collaborationMode: 'plan',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'model/list',
      expect.objectContaining({
        includeHidden: false,
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      3,
      'turn/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.3-codex',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
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

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
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
