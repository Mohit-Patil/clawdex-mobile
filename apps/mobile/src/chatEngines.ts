import type { ChatEngine } from './api/types';

type ChatEngineMetadata = {
  label: string;
  badgeColors: {
    backgroundColor: string;
    borderColor: string;
    textColor: string;
  };
  pickerDescription: string;
  defaultsDescription: string;
  icon: 'sparkles-outline' | 'layers-outline' | 'code-slash-outline';
};

export const DEFAULT_CHAT_ENGINE: ChatEngine = 'codex';
export const ALL_CHAT_ENGINES: ReadonlyArray<ChatEngine> = ['codex', 'opencode', 't3code'];

const CHAT_ENGINE_METADATA: Record<ChatEngine, ChatEngineMetadata> = {
  codex: {
    label: 'Codex',
    badgeColors: {
      backgroundColor: 'rgba(181, 189, 204, 0.14)',
      borderColor: 'rgba(181, 189, 204, 0.36)',
      textColor: '#D5DBE8',
    },
    pickerDescription: 'Use the Codex backend and its model catalog.',
    defaultsDescription: 'Use Codex defaults for new chats.',
    icon: 'sparkles-outline',
  },
  opencode: {
    label: 'OpenCode',
    badgeColors: {
      backgroundColor: 'rgba(143, 163, 191, 0.14)',
      borderColor: 'rgba(143, 163, 191, 0.34)',
      textColor: '#D7E3F7',
    },
    pickerDescription: 'Use the OpenCode backend and its connected provider models.',
    defaultsDescription: 'Use OpenCode defaults for new chats.',
    icon: 'layers-outline',
  },
  t3code: {
    label: 'T3 Code',
    badgeColors: {
      backgroundColor: 'rgba(110, 190, 167, 0.14)',
      borderColor: 'rgba(110, 190, 167, 0.34)',
      textColor: '#D4F4EC',
    },
    pickerDescription: 'Use the T3 Code backend and its orchestration runtime.',
    defaultsDescription: 'Use T3 Code defaults for new chats.',
    icon: 'code-slash-outline',
  },
};

export function normalizeChatEngine(value: unknown): ChatEngine | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return ALL_CHAT_ENGINES.find((engine) => engine === normalized) ?? null;
}

export function resolveChatEngine(
  value: ChatEngine | string | null | undefined,
  fallback: ChatEngine = DEFAULT_CHAT_ENGINE
): ChatEngine {
  return normalizeChatEngine(value) ?? fallback;
}

export function getChatEngineMetadata(
  value: ChatEngine | string | null | undefined,
  fallback: ChatEngine = DEFAULT_CHAT_ENGINE
): ChatEngineMetadata & { id: ChatEngine } {
  const engine = resolveChatEngine(value, fallback);
  return {
    id: engine,
    ...CHAT_ENGINE_METADATA[engine],
  };
}

export function getChatEngineLabel(value: ChatEngine | string | null | undefined): string {
  return getChatEngineMetadata(value).label;
}

export function getChatEngineBadgeColors(value: ChatEngine | string | null | undefined): {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
} {
  return getChatEngineMetadata(value).badgeColors;
}
