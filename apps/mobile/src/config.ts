const hostBridgeUrl =
  process.env.EXPO_PUBLIC_HOST_BRIDGE_URL?.replace(/\/$/, '') ??
  process.env.EXPO_PUBLIC_MAC_BRIDGE_URL?.replace(/\/$/, '') ??
  'http://127.0.0.1:8787';
const hostBridgeToken =
  process.env.EXPO_PUBLIC_HOST_BRIDGE_TOKEN?.trim() ||
  process.env.EXPO_PUBLIC_MAC_BRIDGE_TOKEN?.trim() ||
  null;
const allowWsQueryTokenAuth =
  process.env.EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH?.trim().toLowerCase() ===
  'true';
const allowInsecureRemoteBridge =
  process.env.EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE?.trim().toLowerCase() ===
  'true';
const privacyPolicyUrl = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim() || null;
const termsOfServiceUrl = process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL?.trim() || null;
const externalStatusFullSyncDebounceMs = parseNonNegativeIntEnv(
  process.env.EXPO_PUBLIC_EXTERNAL_STATUS_FULL_SYNC_DEBOUNCE_MS,
  450
);

if (isInsecureRemoteUrl(hostBridgeUrl) && !allowInsecureRemoteBridge) {
  console.warn(
    'EXPO_PUBLIC_HOST_BRIDGE_URL uses http:// for a non-local host. Prefer https:// for remote host bridge access.'
  );
}

export const env = {
  hostBridgeUrl,
  hostBridgeToken,
  allowWsQueryTokenAuth,
  externalStatusFullSyncDebounceMs,
  privacyPolicyUrl,
  termsOfServiceUrl
};

function parseNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function isInsecureRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') {
      return false;
    }

    return !isLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}
