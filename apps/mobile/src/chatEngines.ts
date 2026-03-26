import type { ChatEngine } from './api/types';

export function resolveChatEngine(value: ChatEngine | null | undefined): ChatEngine {
  return value === 'opencode' ? 'opencode' : 'codex';
}

export function getChatEngineLabel(value: ChatEngine | null | undefined): string {
  return resolveChatEngine(value) === 'opencode' ? 'OpenCode' : 'Codex';
}

export function getChatEngineBadgeColors(value: ChatEngine | null | undefined): {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
} {
  const engine = resolveChatEngine(value);
  if (engine === 'opencode') {
    return {
      backgroundColor: 'rgba(143, 163, 191, 0.14)',
      borderColor: 'rgba(143, 163, 191, 0.34)',
      textColor: '#D7E3F7',
    };
  }

  return {
    backgroundColor: 'rgba(181, 189, 204, 0.14)',
    borderColor: 'rgba(181, 189, 204, 0.36)',
    textColor: '#D5DBE8',
  };
}
