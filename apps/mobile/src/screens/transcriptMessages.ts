import type { ChatMessage } from '../api/types';

export function getVisibleTranscriptMessages(
  messages: ChatMessage[],
  showToolCalls: boolean
): ChatMessage[] {
  const filtered = messages.filter((msg) => {
    const text = msg.content || '';
    if (!showToolCalls && msg.role === 'system') {
      return false;
    }
    if (text.includes('FINAL_TASK_RESULT_JSON')) {
      return false;
    }
    if (text.includes('Current working directory is:')) {
      return false;
    }
    if (text.includes('You are operating in task worktree')) {
      return false;
    }
    if (msg.role === 'assistant' && !text.trim()) {
      return false;
    }
    return true;
  });

  return filtered.filter((msg, index) => {
    if (msg.role !== 'assistant') {
      return true;
    }

    const next = filtered[index + 1];
    return !next || next.role !== 'assistant';
  });
}
