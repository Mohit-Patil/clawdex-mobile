import type { ChatMessage } from '../../api/types';
import {
  buildTranscriptDisplayItems,
  getVisibleTranscriptMessages,
  MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP,
  syncVisibleSubAgentStatuses,
  type TranscriptDisplayItem,
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

  it('hides tool rows when detailed tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Investigate this bug'),
      message('t1', 'system', '• Ran `npm test`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Found the issue.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
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

  it('keeps compaction rows visible when tool calls are disabled', () => {
    const messages = [
      message('u1', 'user', 'Summarize this thread'),
      message('c1', 'system', '• Compacted conversation context', {
        systemKind: 'compaction',
      }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'c1',
      'a1',
    ]);
  });

  it('keeps every message in a consecutive assistant run', () => {
    const messages = [
      message('u1', 'user', 'Answer this'),
      message('a1', 'assistant', 'Working...'),
      message('a2', 'assistant', 'Final answer'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ]);
  });

  it('keeps consecutive assistant image messages visible', () => {
    const messages = [
      message('u1', 'user', 'Show me the QR'),
      message('a1', 'assistant', '[local image: /tmp/bridge-pairing-qr.png]'),
      message('a2', 'assistant', 'Above.'),
    ];

    expect(getVisibleTranscriptMessages(messages, false).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
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
        renderKey: 'user-1-Audit this',
      },
      {
        kind: 'toolGroup',
        id: 'tool-group-t1-t2',
        messages: [messages[1], messages[2]],
      },
      {
        kind: 'message',
        message: messages[3],
        renderKey: 'a1',
      },
    ]);
  });

  it('groups legacy untyped tool timeline rows into one toolGroup item', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      message('s1', 'system', '• Searched web for "react native flatlist"'),
      message('s2', 'system', '• Called tool `openaiDeveloperDocs / search_openai_docs`'),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'message',
        message: messages[0],
        renderKey: 'user-1-Audit this',
      },
      {
        kind: 'toolGroup',
        id: 'tool-group-s1-s2',
        messages: [messages[1], messages[2]],
      },
      {
        kind: 'message',
        message: messages[3],
        renderKey: 'a1',
      },
    ]);
  });

  it('keeps legacy untyped reasoning rows out of tool groups', () => {
    const messages = [
      message('u1', 'user', 'Think through this'),
      message('r1', 'system', '• Reasoning\n  └ Inspecting the workspace state'),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'message',
        message: messages[0],
        renderKey: 'user-1-Think through this',
      },
      {
        kind: 'message',
        message: messages[1],
        renderKey: 'r1',
      },
      {
        kind: 'message',
        message: messages[2],
        renderKey: 'a1',
      },
    ]);
  });

  it('keeps legacy untyped sub-agent lifecycle rows out of tool groups', () => {
    const messages = [
      message('u1', 'user', 'Review this'),
      message('s1', 'system', '• Waiting on sub-agent\n  └ Thread: child'),
      message('s2', 'system', '• Sent follow-up to sub-agent\n  └ Thread: child'),
      message('s3', 'system', '• Closed sub-agent thread\n  └ Thread: child'),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'message',
        message: messages[0],
        renderKey: 'user-1-Review this',
      },
      {
        kind: 'message',
        message: messages[1],
        renderKey: 's1',
      },
      {
        kind: 'message',
        message: messages[2],
        renderKey: 's2',
      },
      {
        kind: 'message',
        message: messages[3],
        renderKey: 's3',
      },
      {
        kind: 'message',
        message: messages[4],
        renderKey: 'a1',
      },
    ]);
  });

  it('keeps compaction rows separate from grouped tool activity', () => {
    const messages = [
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('c1', 'system', '• Compacted conversation context', {
        systemKind: 'compaction',
      }),
      message('t2', 'system', '• Ran `ls`', { systemKind: 'tool' }),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'toolGroup',
        id: 'tool-group-t1-t1',
        messages: [messages[0]],
      },
      {
        kind: 'message',
        message: messages[1],
        renderKey: 'c1',
      },
      {
        kind: 'toolGroup',
        id: 'tool-group-t2-t2',
        messages: [messages[2]],
      },
    ]);
  });

  it('chunks very long consecutive tool runs into multiple tool groups', () => {
    const toolMessages = Array.from({ length: MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP + 3 }, (_, index) =>
      message(`t${String(index)}`, 'system', `• Tool ${String(index)}`, { systemKind: 'tool' })
    );

    const items = buildTranscriptDisplayItems(toolMessages);
    const groups = items.filter((item): item is Extract<TranscriptDisplayItem, { kind: 'toolGroup' }> => item.kind === 'toolGroup');

    expect(groups.length).toBe(2);
    expect(groups[0]?.messages.length).toBe(MAX_TOOL_MESSAGES_PER_TRANSCRIPT_GROUP);
    expect(groups[1]?.messages.length).toBe(3);
  });

  it('wraps a single tool message in a toolGroup for consistent UI', () => {
    const messages = [
      message('u1', 'user', 'Audit this'),
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      message('a1', 'assistant', 'Done.'),
    ];

    expect(buildTranscriptDisplayItems(messages)).toEqual([
      {
        kind: 'message',
        message: messages[0],
        renderKey: 'user-1-Audit this',
      },
      {
        kind: 'toolGroup',
        id: 'tool-group-t1-t1',
        messages: [messages[1]],
      },
      {
        kind: 'message',
        message: messages[2],
        renderKey: 'a1',
      },
    ]);
  });

  it('keeps user render keys stable when non-user rows are inserted later', () => {
    const baseMessages = [
      message('u1', 'user', 'First prompt'),
      message('a1', 'assistant', 'First answer'),
      message('u2', 'user', 'Second prompt'),
    ];
    const withToolMessage = [
      baseMessages[0],
      message('t1', 'system', '• Ran `pwd`', { systemKind: 'tool' }),
      ...baseMessages.slice(1),
    ];

    const isUserTranscriptItem = (
      item: TranscriptDisplayItem
    ): item is Extract<TranscriptDisplayItem, { kind: 'message' }> =>
      item.kind === 'message' && item.message.role === 'user';

    const baseUserKeys = buildTranscriptDisplayItems(baseMessages)
      .filter(isUserTranscriptItem)
      .map((item) => item.renderKey);
    const insertedUserKeys = buildTranscriptDisplayItems(withToolMessage)
      .filter(isUserTranscriptItem)
      .map((item) => item.renderKey);

    expect(insertedUserKeys).toEqual(baseUserKeys);
  });
});
