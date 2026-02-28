const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

export function normalizeBridgeUrlInput(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  if (!parsed.hostname || parsed.username || parsed.password) {
    return null;
  }

  const normalizedProtocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');

  parsed.protocol = normalizedProtocol;
  parsed.pathname = normalizedPath || '';
  parsed.search = '';
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';

  return parsed.toString().replace(/\/$/, '');
}

export function isInsecureRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') {
      return false;
    }

    return !isLikelyPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function toBridgeHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/health`;
}

function isLikelyPrivateHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  const host =
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized;
  if (!host) {
    return false;
  }

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local')
  ) {
    return true;
  }

  if (host.includes(':')) {
    return (
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:')
    );
  }

  const octets = host.split('.');
  if (octets.length !== 4) {
    return false;
  }

  const [firstStr, secondStr] = octets;
  const first = Number.parseInt(firstStr, 10);
  const second = Number.parseInt(secondStr, 10);
  if (!Number.isInteger(first) || !Number.isInteger(second)) {
    return false;
  }

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}
