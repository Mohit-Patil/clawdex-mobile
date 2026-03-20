import type { ChatMessage, ChatStatus } from '../api/types';

export function getVisibleTranscriptMessages(
  messages: ChatMessage[],
  showToolCalls: boolean
): ChatMessage[] {
  const filtered = messages.filter((msg) => {
    const text = msg.content || '';
    if (!showToolCalls && msg.role === 'system' && msg.systemKind !== 'subAgent') {
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

export function syncVisibleSubAgentStatuses(
  messages: ChatMessage[],
  threadStatuses: ReadonlyMap<string, ChatStatus>
): ChatMessage[] {
  if (threadStatuses.size === 0) {
    return messages;
  }

  return messages.map((message) => syncSubAgentMessageStatus(message, threadStatuses));
}

function syncSubAgentMessageStatus(
  message: ChatMessage,
  threadStatuses: ReadonlyMap<string, ChatStatus>
): ChatMessage {
  if (message.systemKind !== 'subAgent' || !message.subAgentMeta) {
    return message;
  }

  const receiverThreadIds = message.subAgentMeta.receiverThreadIds ?? [];
  const nextStatus =
    receiverThreadIds
      .map((threadId) => threadStatuses.get(threadId))
      .find((status): status is ChatStatus => typeof status === 'string') ?? null;

  if (!nextStatus) {
    return message;
  }

  const nextContent = replaceSubAgentStatusLine(message.content, nextStatus);
  const previousStatus = message.subAgentMeta.agentStatus;
  if (nextContent === message.content && previousStatus === nextStatus) {
    return message;
  }

  return {
    ...message,
    content: nextContent,
    subAgentMeta: {
      ...message.subAgentMeta,
      agentStatus: nextStatus,
    },
  };
}

function replaceSubAgentStatusLine(content: string, status: ChatStatus): string {
  const statusLine = `Status: ${status}`;
  const lines = content.split('\n');
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (!/^\s*Status:\s*/i.test(line)) {
      return line;
    }

    replaced = true;
    const indentation = line.match(/^\s*/)?.[0] ?? '';
    return `${indentation}${statusLine}`;
  });

  if (replaced) {
    return nextLines.join('\n');
  }

  return [...nextLines, `  ${statusLine}`].join('\n');
}
