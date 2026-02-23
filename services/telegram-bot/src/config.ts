import { resolve as resolvePath } from 'node:path';

const DEFAULT_DEVELOPER_INSTRUCTIONS =
  'When you need clarification, call request_user_input instead of asking only in plain text. Provide 2-3 concise options whenever possible and use isOther when free-form input is appropriate.';

const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TELEGRAM_MENU_BUTTON_TEXT = 'Open App';

export interface BotConfig {
  telegram: {
    botToken: string;
    apiBaseUrl: string;
    pollTimeoutSec: number;
    pollLimit: number;
    streamUpdateIntervalMs: number;
    messageMaxLength: number;
    statePath: string;
    allowedChatIds: Set<string>;
    allowedUserIds: Set<string>;
    allowUnrestricted: boolean;
    miniAppUrl: string | null;
    menuButtonText: string;
  };
  bridge: {
    wsUrl: string;
    authToken: string | null;
    allowInsecureNoAuth: boolean;
    requestTimeoutMs: number;
    defaultCwd: string | null;
    defaultModel: string | null;
    defaultEffort: string | null;
    developerInstructions: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const botToken = required(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN');
  const allowUnrestricted = parseBoolean(env.TELEGRAM_ALLOW_UNRESTRICTED);
  const allowedChatIds = parseCsvSet(env.TELEGRAM_ALLOWED_CHAT_IDS);
  const allowedUserIds = parseCsvSet(env.TELEGRAM_ALLOWED_USER_IDS);
  const miniAppUrl = normalizeMiniAppUrl(env.TELEGRAM_MINI_APP_URL);
  const menuButtonText =
    normalizeString(env.TELEGRAM_MENU_BUTTON_TEXT) ?? DEFAULT_TELEGRAM_MENU_BUTTON_TEXT;

  if (!allowUnrestricted && allowedChatIds.size === 0 && allowedUserIds.size === 0) {
    throw new Error(
      'Set TELEGRAM_ALLOWED_CHAT_IDS or TELEGRAM_ALLOWED_USER_IDS. Set TELEGRAM_ALLOW_UNRESTRICTED=true only for local testing.'
    );
  }

  const authToken = normalizeString(env.BRIDGE_AUTH_TOKEN);
  const allowInsecureNoAuth = parseBoolean(env.BRIDGE_ALLOW_INSECURE_NO_AUTH);

  if (!authToken && !allowInsecureNoAuth) {
    throw new Error(
      'BRIDGE_AUTH_TOKEN is required for Telegram integration. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development.'
    );
  }

  return {
    telegram: {
      botToken,
      apiBaseUrl: normalizeUrl(env.TELEGRAM_API_BASE_URL) ?? DEFAULT_TELEGRAM_API_BASE_URL,
      pollTimeoutSec: parseInteger(env.TELEGRAM_POLL_TIMEOUT_SEC, 25, 1, 50),
      pollLimit: parseInteger(env.TELEGRAM_POLL_LIMIT, 50, 1, 100),
      streamUpdateIntervalMs: parseInteger(
        env.TELEGRAM_STREAM_UPDATE_INTERVAL_MS,
        1200,
        300,
        10_000
      ),
      messageMaxLength: parseInteger(env.TELEGRAM_MESSAGE_MAX_LENGTH, 3900, 200, 4096),
      statePath: resolvePath(normalizeString(env.TELEGRAM_STATE_PATH) ?? '.telegram-bot-state.json'),
      allowedChatIds,
      allowedUserIds,
      allowUnrestricted,
      miniAppUrl,
      menuButtonText,
    },
    bridge: {
      wsUrl: normalizeUrl(env.BRIDGE_WS_URL) ?? 'ws://127.0.0.1:8787/rpc',
      authToken,
      allowInsecureNoAuth,
      requestTimeoutMs: parseInteger(env.BRIDGE_REQUEST_TIMEOUT_MS, 180_000, 5_000, 600_000),
      defaultCwd: normalizeString(env.TELEGRAM_DEFAULT_CWD),
      defaultModel: normalizeString(env.TELEGRAM_DEFAULT_MODEL),
      defaultEffort: normalizeEffort(env.TELEGRAM_DEFAULT_EFFORT),
      developerInstructions:
        normalizeString(env.TELEGRAM_DEVELOPER_INSTRUCTIONS) ?? DEFAULT_DEVELOPER_INSTRUCTIONS,
    },
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function normalizeString(value: string | undefined | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(value: string | undefined | null): string | null {
  const raw = normalizeString(value);
  if (!raw) {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

function normalizeMiniAppUrl(value: string | undefined | null): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('https://')) {
    return normalized;
  }

  throw new Error('TELEGRAM_MINI_APP_URL must start with https://');
}

function parseCsvSet(value: string | undefined): Set<string> {
  if (typeof value !== 'string') {
    return new Set<string>();
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return new Set(entries);
}

function parseBoolean(value: string | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  return value.trim().toLowerCase() === 'true';
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeEffort(value: string | undefined): string | null {
  const normalized = normalizeString(value)?.toLowerCase() ?? null;
  if (!normalized) {
    return null;
  }

  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }

  return null;
}
