import type { ChatEngine, ChatSummary } from '../api/types';
import { ALL_CHAT_ENGINES, resolveChatEngine } from '../chatEngines';

export const DEFAULT_DRAWER_CHAT_ENGINES: ReadonlyArray<ChatEngine> = ALL_CHAT_ENGINES;

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

export function isSubAgentChat(chat: ChatSummary): boolean {
  return Boolean(chat.parentThreadId) || chat.sourceKind?.startsWith('subAgent') === true;
}
