import type { ChatEngine } from './api/types';
import type { ThemeMode } from './theme';

export function resolveChatEngine(value: ChatEngine | null | undefined): ChatEngine {
  if (value === 'opencode' || value === 'cursor') {
    return value;
  }
  return 'codex';
}

export function getChatEngineLabel(value: ChatEngine | null | undefined): string {
  const engine = resolveChatEngine(value);
  if (engine === 'opencode') {
    return 'OpenCode';
  }
  if (engine === 'cursor') {
    return 'Cursor';
  }
  return 'Codex';
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

  if (engine === 'cursor') {
    return {
      backgroundColor: isLight ? 'rgba(35, 117, 92, 0.10)' : 'rgba(87, 201, 163, 0.14)',
      borderColor: isLight ? 'rgba(35, 117, 92, 0.22)' : 'rgba(87, 201, 163, 0.34)',
      textColor: isLight ? '#1F6B54' : '#C5F2E2',
    };
  }

  return {
    backgroundColor: isLight ? 'rgba(63, 72, 84, 0.10)' : 'rgba(181, 189, 204, 0.14)',
    borderColor: isLight ? 'rgba(63, 72, 84, 0.22)' : 'rgba(181, 189, 204, 0.36)',
    textColor: isLight ? '#3F4854' : '#D5DBE8',
  };
}
