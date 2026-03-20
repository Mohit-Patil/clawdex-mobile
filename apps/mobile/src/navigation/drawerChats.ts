import type { ChatSummary } from '../api/types';

export function filterDrawerChats(chats: ChatSummary[]): ChatSummary[] {
  return chats.filter((chat) => !isSubAgentChat(chat));
}

export function isSubAgentChat(chat: ChatSummary): boolean {
  return Boolean(chat.parentThreadId) || chat.sourceKind?.startsWith('subAgent') === true;
}
