import { mapChat, toRawThread } from '../chatMapping';

describe('chatMapping', () => {
  it('maps command execution items into system trace messages', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_cmd',
        preview: 'done',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'u1',
                content: [{ type: 'text', text: 'show status' }],
              },
              {
                type: 'commandExecution',
                id: 'cmd1',
                command: 'git status --short',
                status: 'completed',
                aggregatedOutput: ' M apps/mobile/src/api/ws.ts\n M apps/mobile/src/screens/MainScreen.tsx',
                exitCode: 0,
              },
              {
                type: 'agentMessage',
                id: 'a1',
                text: 'Done',
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0].role).toBe('user');
    expect(chat.messages[1].role).toBe('system');
    expect(chat.messages[1].systemKind).toBe('tool');
    expect(chat.messages[1].content).toContain('• Ran `git status --short`');
    expect(chat.messages[1].content).toContain('M apps/mobile/src/api/ws.ts');
    expect(chat.messages[2].role).toBe('assistant');
    expect(chat.messages[2].content).toBe('Done');
  });

  it('maps plan and tool items into readable system timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_tools',
        preview: 'tools',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'plan',
                id: 'plan1',
                text: '• Explored\n  └ Read MainScreen.tsx',
              },
              {
                type: 'webSearch',
                id: 'search1',
                query: 'react native keyboard inset',
              },
              {
                type: 'mcpToolCall',
                id: 'tool1',
                server: 'filesystem',
                tool: 'read_file',
                status: 'completed',
                result: { ok: true },
              },
              {
                type: 'fileChange',
                id: 'patch1',
                status: 'completed',
                changes: [{ path: 'apps/mobile/src/screens/MainScreen.tsx' }],
              },
            ],
          },
        ],
      })
    );

    const systemMessages = chat.messages.filter((message) => message.role === 'system');
    expect(systemMessages).toHaveLength(4);
    expect(systemMessages.every((message) => message.systemKind === 'tool')).toBe(true);
    expect(systemMessages[0].content).toContain('• Explored');
    expect(systemMessages[1].content).toContain('• Searched web for "react native keyboard inset"');
    expect(systemMessages[2].content).toContain('• Called tool `filesystem / read_file`');
    expect(systemMessages[3].content).toContain('• Applied file changes');
  });

  it('maps sub-agent source metadata and collaboration items', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_sub',
        preview: 'worker',
        agentNickname: 'Atlas',
        agentRole: 'explorer',
        createdAt: 1700000000,
        updatedAt: 1700000004,
        status: { type: 'idle' },
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'thr_root',
              depth: 1,
            },
          },
        },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'collabToolCall',
                id: 'collab1',
                tool: 'spawn_agent',
                status: 'completed',
                prompt: 'Inspect the websocket protocol and summarize it',
                receiver_thread_ids: ['thr_sub'],
                sender_thread_id: 'thr_root',
                agentStatus: 'running',
              },
            ],
          },
        ],
      })
    );

    expect(chat.sourceKind).toBe('subAgentThreadSpawn');
    expect(chat.parentThreadId).toBe('thr_root');
    expect(chat.subAgentDepth).toBe(1);
    expect(chat.agentNickname).toBe('Atlas');
    expect(chat.agentRole).toBe('explorer');
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('subAgent');
    expect(chat.messages[0].content).toContain('• Spawned sub-agent');
    expect(chat.messages[0].content).toContain('Prompt: Inspect the websocket protocol');
    expect(chat.messages[0].content).toContain('Thread: thr_sub');
    expect(chat.messages[0].subAgentMeta).toEqual({
      tool: 'spawn_agent',
      prompt: 'Inspect the websocket protocol and summarize it',
      senderThreadId: 'thr_root',
      receiverThreadIds: ['thr_sub'],
      agentStatus: 'running',
    });
  });

  it('maps user mention attachments into readable file markers', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_mentions',
        preview: 'files',
        createdAt: 1700000000,
        updatedAt: 1700000003,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'u_mentions',
                content: [
                  { type: 'text', text: 'please review these files' },
                  { type: 'mention', path: 'apps/mobile/src/screens/MainScreen.tsx' },
                  { type: 'mention', path: 'apps/mobile/src/api/client.ts' },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('user');
    expect(chat.messages[0].content).toContain('please review these files');
    expect(chat.messages[0].content).toContain('[file: apps/mobile/src/screens/MainScreen.tsx]');
    expect(chat.messages[0].content).toContain('[file: apps/mobile/src/api/client.ts]');
  });
});
