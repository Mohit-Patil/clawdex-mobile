import type { ChatMessage } from '../../api/types';
import { getVisibleTranscriptMessages } from '../transcriptMessages';

function message(
  id: string,
  role: ChatMessage['role'],
  content: string
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: '2026-03-19T00:00:00.000Z',
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
});
