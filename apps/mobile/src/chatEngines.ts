import type { ChatEngine } from './api/types';
import type { ThemeMode } from './theme';

export function resolveChatEngine(value: ChatEngine | null | undefined): ChatEngine {
  return value === 'opencode' ? 'opencode' : 'codex';
}

export function getChatEngineLabel(value: ChatEngine | null | undefined): string {
  return resolveChatEngine(value) === 'opencode' ? 'OpenCode' : 'Codex';
}

export function getChatEngineBadgeColors(
  value: ChatEngine | null | undefined,
  mode: ThemeMode = 'dark'
): {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
} {
  const engine = resolveChatEngine(value);
  const isLight = mode === 'light';
  if (engine === 'opencode') {
    return {
      backgroundColor: isLight ? 'rgba(59, 91, 138, 0.10)' : 'rgba(143, 163, 191, 0.14)',
      borderColor: isLight ? 'rgba(59, 91, 138, 0.22)' : 'rgba(143, 163, 191, 0.34)',
      textColor: isLight ? '#2F4F78' : '#D7E3F7',
    };
  }

  return {
    backgroundColor: isLight ? 'rgba(63, 72, 84, 0.10)' : 'rgba(181, 189, 204, 0.14)',
    borderColor: isLight ? 'rgba(63, 72, 84, 0.22)' : 'rgba(181, 189, 204, 0.36)',
    textColor: isLight ? '#3F4854' : '#D5DBE8',
  };
}
