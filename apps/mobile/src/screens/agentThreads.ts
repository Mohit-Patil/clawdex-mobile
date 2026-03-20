import type { ChatSummary } from '../api/types';

export interface RelatedAgentThreadsResult {
  rootThreadId: string | null;
  threads: ChatSummary[];
}

export interface LiveAgentPanelThreadLike {
  id: string;
  isRootThread: boolean;
  isActive: boolean;
}

export function collectRelatedAgentThreads(
  chats: ChatSummary[],
  focusChat: ChatSummary | null
): RelatedAgentThreadsResult {
  if (!focusChat) {
    return {
      rootThreadId: null,
      threads: [],
    };
  }

  const chatMap = new Map<string, ChatSummary>();
  for (const chat of chats) {
    chatMap.set(chat.id, chat);
  }
  if (!chatMap.has(focusChat.id)) {
    chatMap.set(focusChat.id, focusChat);
  }

  const rootThreadId = resolveRootThreadId(focusChat.id, chatMap);
  const threads = Array.from(chatMap.values())
    .filter((chat) => resolveRootThreadId(chat.id, chatMap) === rootThreadId)
    .sort((left, right) => compareAgentThreads(left, right, rootThreadId));

  return {
    rootThreadId,
    threads,
  };
}

export function findMatchingAgentThread(
  threads: ChatSummary[],
  query: string
): ChatSummary | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const exactMatch =
    threads.find((chat) => {
      const title = chat.title.trim().toLowerCase();
      return chat.id.toLowerCase() === normalized || title === normalized;
    }) ?? null;
  if (exactMatch) {
    return exactMatch;
  }

  return (
    threads.find((chat) => {
      const nickname = chat.agentNickname?.trim().toLowerCase() ?? '';
      const role = chat.agentRole?.trim().toLowerCase() ?? '';
      const title = chat.title.trim().toLowerCase();
      const preview = chat.lastMessagePreview.trim().toLowerCase();
      return (
        chat.id.toLowerCase().includes(normalized) ||
        nickname.includes(normalized) ||
        role.includes(normalized) ||
        title.includes(normalized) ||
        preview.includes(normalized)
      );
    }) ?? null
  );
}

export function describeAgentThreadSource(
  chat: ChatSummary,
  rootThreadId: string | null
): string {
  if (rootThreadId && chat.id === rootThreadId) {
    return 'Main thread';
  }

  switch (chat.sourceKind) {
    case 'subAgentReview':
      return 'Review agent';
    case 'subAgentCompact':
      return 'Compaction agent';
    case 'subAgentThreadSpawn':
    case 'subAgent':
      return 'Spawned sub-agent';
    case 'subAgentOther':
      return 'Sub-agent';
    default:
      return 'Agent thread';
  }
}

export function collectLiveAgentPanelThreadIds(
  threads: LiveAgentPanelThreadLike[]
): string[] {
  const hasActiveSubAgent = threads.some((thread) => !thread.isRootThread && thread.isActive);
  if (!hasActiveSubAgent) {
    return [];
  }

  return threads
    .filter((thread) => thread.isRootThread || thread.isActive)
    .map((thread) => thread.id);
}

function resolveRootThreadId(
  threadId: string,
  chatMap: Map<string, ChatSummary>
): string {
  let currentId = threadId;
  const seen = new Set<string>();

  while (true) {
    if (seen.has(currentId)) {
      return currentId;
    }
    seen.add(currentId);

    const current = chatMap.get(currentId);
    const parentThreadId = current?.parentThreadId?.trim();
    if (!parentThreadId) {
      return currentId;
    }
    if (!chatMap.has(parentThreadId)) {
      return parentThreadId;
    }

    currentId = parentThreadId;
  }
}

function compareAgentThreads(
  left: ChatSummary,
  right: ChatSummary,
  rootThreadId: string
): number {
  if (left.id === rootThreadId && right.id !== rootThreadId) {
    return -1;
  }
  if (right.id === rootThreadId && left.id !== rootThreadId) {
    return 1;
  }

  if (left.status === 'running' && right.status !== 'running') {
    return -1;
  }
  if (right.status === 'running' && left.status !== 'running') {
    return 1;
  }

  const leftDepth = left.subAgentDepth ?? 0;
  const rightDepth = right.subAgentDepth ?? 0;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }

  return right.updatedAt.localeCompare(left.updatedAt);
}
