import type { ChatMessage } from '../api/types';

export interface TrimmedSubAgentTranscript {
  messages: ChatMessage[];
  hiddenInheritedMessageCount: number;
}

export function trimInheritedParentMessages(
  parentMessages: ChatMessage[],
  childMessages: ChatMessage[],
  childThreadId?: string | null
): TrimmedSubAgentTranscript {
  const normalizedChildThreadId = childThreadId?.trim() ?? '';
  if (normalizedChildThreadId) {
    const startIndex = findSpawnPromptStartIndex(
      parentMessages,
      childMessages,
      normalizedChildThreadId
    );
    if (startIndex > 0 && startIndex < childMessages.length) {
      return {
        messages: childMessages.slice(startIndex),
        hiddenInheritedMessageCount: startIndex,
      };
    }
  }

  const sharedLeadingCount = sharedLeadingMessageCount(parentMessages, childMessages);
  if (sharedLeadingCount <= 0 || sharedLeadingCount >= childMessages.length) {
    return {
      messages: childMessages,
      hiddenInheritedMessageCount: 0,
    };
  }

  return {
    messages: childMessages.slice(sharedLeadingCount),
    hiddenInheritedMessageCount: sharedLeadingCount,
  };
}

function findSpawnPromptStartIndex(
  parentMessages: ChatMessage[],
  childMessages: ChatMessage[],
  childThreadId: string
): number {
  const prompt = findSpawnPrompt(parentMessages, childThreadId);
  if (!prompt) {
    return -1;
  }

  const normalizedPrompt = normalizeMessageContent(prompt);
  if (!normalizedPrompt) {
    return -1;
  }

  const sharedLeadingCount = sharedLeadingMessageCount(parentMessages, childMessages);
  return childMessages.findIndex((message, index) => {
    if (index < sharedLeadingCount) {
      return false;
    }
    if (message.role !== 'user') {
      return false;
    }

    const candidate = normalizeUserPromptContent(message.content);
    if (!candidate) {
      return false;
    }

    return (
      candidate === normalizedPrompt ||
      candidate.includes(normalizedPrompt) ||
      normalizedPrompt.includes(candidate)
    );
  });
}

function findSpawnPrompt(
  parentMessages: ChatMessage[],
  childThreadId: string
): string | null {
  let fallbackPrompt: string | null = null;

  for (const message of parentMessages) {
    if (message.systemKind !== 'subAgent') {
      continue;
    }

    const meta = message.subAgentMeta;
    if (!meta) {
      continue;
    }

    const receiverThreadIds = meta.receiverThreadIds ?? [];
    if (!receiverThreadIds.includes(childThreadId)) {
      continue;
    }

    const prompt = meta.prompt?.trim();
    if (!prompt) {
      continue;
    }

    const normalizedTool = normalizeMessageContent(meta.tool ?? '');
    if (normalizedTool === 'spawn_agent' || normalizedTool === 'spawnagent') {
      return prompt;
    }

    if (!fallbackPrompt) {
      fallbackPrompt = prompt;
    }
  }

  return fallbackPrompt;
}

function sharedLeadingMessageCount(left: ChatMessage[], right: ChatMessage[]): number {
  const max = Math.min(left.length, right.length);
  let count = 0;

  while (count < max && messagesMatch(left[count], right[count])) {
    count += 1;
  }

  return count;
}

function messagesMatch(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.role === right.role &&
    left.systemKind === right.systemKind &&
    normalizeMessageContent(left.content) === normalizeMessageContent(right.content)
  );
}

function normalizeUserPromptContent(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\[(file|image|local image):/i.test(line));

  return normalizeMessageContent(lines.join('\n'));
}

function normalizeMessageContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
