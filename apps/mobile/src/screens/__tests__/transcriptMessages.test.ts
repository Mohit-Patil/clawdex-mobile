import type { ChatMessage } from '../../api/types';
import {
  buildTranscriptDisplayItems,
  getVisibleTranscriptMessages,
  syncVisibleSubAgentStatuses,
} from '../transcriptMessages';

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extras?: Partial<ChatMessage>
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: '2026-03-19T00:00:00.000Z',
    ...extras,
  };
}

describe('getVisibleTranscriptMessages', () => {
  it('hides system timeline rows when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Investigate this bug'),
      message('s1', 'system', '• Searched web for "react native flatlist"'),
      message('a1', 'assistant', 'Found the issue.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
    ]);
  });

  it('shows system timeline rows when tool calls are enabled', () => {
    const messages = [
      message('u1', 'user', 'Investigate this bug'),
      message('s1', 'system', '• Searched web for "react native flatlist"'),
      message('s2', 'system', '• Called tool `openaiDeveloperDocs / search_openai_docs`'),
      message('a1', 'assistant', 'Found the issue.'),
    ];

    expect(getVisibleTranscriptMessages(messages, true).map((entry) => entry.id)).toEqual([
      'u1',
      's1',
      's2',
      'a1',
    ]);
  });

  it('keeps sub-agent system rows visible when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Review this repository'),
      message('s1', 'system', '• Spawned sub-agent\n  Prompt: Review the mobile app', {
        systemKind: 'subAgent',
      }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      's1',
      'a1',
    ]);
  });

  it('keeps reasoning rows visible when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Explain what you are checking'),
      message('r1', 'system', '• Reasoning\n  └ Inspecting the workspace state', {
        systemKind: 'reasoning',
      }),
      message('a1', 'assistant', 'I found the issue.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'r1',
      'a1',
    ]);
  });

  it('keeps only the last message in a consecutive assistant run', () => {
    const messages = [
      message('u1', 'user', 'Answer this'),
      message('a1', 'assistant', 'Working...'),
      message('a2', 'assistant', 'Final answer'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a2',
    ]);
  });

  it('replaces stale sub-agent status lines with the latest thread status', () => {
    const messages = [
      message('s1', 'system', '• Spawned sub-agent\n  Thread: child\n  Status: running', {
        systemKind: 'subAgent',
        subAgentMeta: {
          receiverThreadIds: ['child'],
          agentStatus: 'running',
        },
      }),
    ];

    const synced = syncVisibleSubAgentStatuses(messages, new Map([['child', 'complete']]));

    expect(synced[0]?.content).toContain('Status: complete');
    expect(synced[0]?.subAgentMeta?.agentStatus).toBe('complete');
  });
});

describe('buildTranscriptDisplayItems', () => {
  it('groups consecutive tool messages into one toolGroup item', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('t2', 'system', '• Ran `ls`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'message',
        message: messages[0],
      },
      {
        kind: 'toolGroup',
        id: 'tool-group-t1-t2',
        messages: [messages[1], messages[2]],
      },
      {
        kind: 'message',
        message: messages[3],
      },
    ]);
  });

  it('keeps a single tool message as a normal message', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'message',
        message: messages[0],
      },
      {
        kind: 'message',
        message: messages[1],
      },
      {
        kind: 'message',
        message: messages[2],
      },
    ]);
  });
});
