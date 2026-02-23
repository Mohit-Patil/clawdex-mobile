const DEFAULT_DEV_INSTRUCTIONS =
  'When you need clarification, call request_user_input instead of asking only in plain text. Provide 2-3 concise options whenever possible and use isOther when free-form input is appropriate.';

export interface MiniAppConfig {
  bridgeWsUrl: string;
  bridgeAuthToken: string | null;
  allowQueryTokenAuth: boolean;
  requestTimeoutMs: number;
  defaultCwd: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
  developerInstructions: string;
}

export function readConfig(): MiniAppConfig {
  const bridgeWsUrl = normalizeUrl(import.meta.env.VITE_BRIDGE_WS_URL) ?? 'ws://127.0.0.1:8787/rpc';
  const bridgeAuthToken = normalizeString(import.meta.env.VITE_BRIDGE_AUTH_TOKEN);
  const allowQueryTokenAuth = parseBoolean(import.meta.env.VITE_BRIDGE_ALLOW_QUERY_TOKEN_AUTH, true);

  if (bridgeAuthToken && !allowQueryTokenAuth) {
    throw new Error(
      'VITE_BRIDGE_ALLOW_QUERY_TOKEN_AUTH must be true when VITE_BRIDGE_AUTH_TOKEN is set for browser websocket clients.'
    );
  }

  return {
    bridgeWsUrl,
    bridgeAuthToken,
    allowQueryTokenAuth,
    requestTimeoutMs: parseInteger(import.meta.env.VITE_BRIDGE_REQUEST_TIMEOUT_MS, 180000, 5000, 600000),
    defaultCwd: normalizeString(import.meta.env.VITE_DEFAULT_CWD),
    defaultModel: normalizeString(import.meta.env.VITE_DEFAULT_MODEL),
    defaultEffort: normalizeEffort(import.meta.env.VITE_DEFAULT_EFFORT),
    developerInstructions:
      normalizeString(import.meta.env.VITE_DEVELOPER_INSTRUCTIONS) ?? DEFAULT_DEV_INSTRUCTIONS,
  };
}

function normalizeString(value: string | undefined | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(value: string | undefined | null): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/+$/, '');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim().toLowerCase() === 'true';
}

function parseInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
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
