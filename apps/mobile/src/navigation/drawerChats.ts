import type { ChatEngine, ChatSummary } from '../api/types';
import { resolveChatEngine } from '../chatEngines';

export const DEFAULT_DRAWER_CHAT_ENGINES: ReadonlyArray<ChatEngine> = ['codex', 'opencode'];

export function filterDrawerChats(chats: ChatSummary[]): ChatSummary[] {
  return chats.filter((chat) => !isSubAgentChat(chat));
}

export function filterDrawerChatsByEngines(
  chats: ChatSummary[],
  engines: ReadonlyArray<ChatEngine>
): ChatSummary[] {
  const normalizedEngines = Array.from(new Set(engines.map((engine) => resolveChatEngine(engine))));
  if (normalizedEngines.length === 0 || normalizedEngines.length >= DEFAULT_DRAWER_CHAT_ENGINES.length) {
    return chats;
  }

  const allowedEngines = new Set(normalizedEngines);
  return chats.filter((chat) => allowedEngines.has(resolveChatEngine(chat.engine)));
}

export function searchDrawerChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const terms = normalizeSearchQuery(query);
  if (terms.length === 0) {
    return chats;
  }

  return chats.filter((chat) => {
    const haystack = [
      chat.title,
      chat.lastMessagePreview,
      chat.cwd,
      chat.lastError,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .toLocaleLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function isSubAgentChat(chat: ChatSummary): boolean {
  return Boolean(chat.parentThreadId) || chat.sourceKind?.startsWith('subAgent') === true;
}

function normalizeSearchQuery(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}
