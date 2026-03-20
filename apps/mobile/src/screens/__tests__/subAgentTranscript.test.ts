import type { ChatMessage } from '../../api/types';
import { trimInheritedParentMessages } from '../subAgentTranscript';

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  options?: {
    systemKind?: ChatMessage['systemKind'];
    subAgentMeta?: ChatMessage['subAgentMeta'];
  }
): ChatMessage {
  return {
    id,
    role,
    content,
    systemKind: options?.systemKind,
    subAgentMeta: options?.subAgentMeta,
    createdAt: '2026-03-20T00:00:00.000Z',
  };
}

describe('trimInheritedParentMessages', () => {
  it('anchors a spawned sub-agent transcript at the child prompt', () => {
    const parentMessages = [
      message('m1', 'user', 'Parent question'),
      message('m2', 'assistant', 'Parent answer'),
      message('m3', 'system', '• Spawned sub-agent', {
        systemKind: 'subAgent',
        subAgentMeta: {
          tool: 'spawn_agent',
          prompt: 'Inspect the settings architecture',
          receiverThreadIds: ['child-thread'],
        },
      }),
    ];
    const childMessages = [
      message('c1', 'user', 'Parent question'),
      message('c2', 'assistant', 'Parent answer'),
      message('c3', 'user', 'Inspect the settings architecture'),
      message('c4', 'assistant', 'The setting should live in App.tsx.'),
    ];

    expect(trimInheritedParentMessages(parentMessages, childMessages, 'child-thread')).toEqual({
      messages: childMessages.slice(2),
      hiddenInheritedMessageCount: 2,
    });
  });

  it('matches spawned prompts even when the child message includes attachment markers', () => {
    const parentMessages = [
      message('m1', 'system', '• Spawned sub-agent', {
        systemKind: 'subAgent',
        subAgentMeta: {
          tool: 'spawn_agent',
          prompt: 'Review the websocket implementation',
          receiverThreadIds: ['child-thread'],
        },
      }),
    ];
    const childMessages = [
      message('c1', 'assistant', 'Older inherited answer'),
      message(
        'c2',
        'user',
        'Review the websocket implementation\n[file: apps/mobile/src/api/ws.ts]'
      ),
      message('c3', 'assistant', 'Here is the websocket review.'),
    ];

    expect(trimInheritedParentMessages(parentMessages, childMessages, 'child-thread')).toEqual({
      messages: childMessages.slice(1),
      hiddenInheritedMessageCount: 1,
    });
  });

  it('falls back to shared-prefix trimming when no spawn prompt metadata is available', () => {
    const parentMessages = [message('m1', 'user', 'Parent question')];
    const childMessages = [
      message('m1-copy', 'user', 'Parent question'),
      message('m2', 'user', 'Child-only question'),
    ];

    expect(trimInheritedParentMessages(parentMessages, childMessages)).toEqual({
      messages: childMessages.slice(1),
      hiddenInheritedMessageCount: 1,
    });
  });

  it('does not hide the entire child transcript when every message matches', () => {
    const parentMessages = [
      message('m1', 'user', 'Shared prompt'),
      message('m2', 'assistant', 'Shared answer'),
    ];
    const childMessages = [...parentMessages];

    expect(trimInheritedParentMessages(parentMessages, childMessages)).toEqual({
      messages: childMessages,
      hiddenInheritedMessageCount: 0,
    });
  });
});
