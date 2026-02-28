import { isInsecureRemoteUrl, normalizeBridgeUrlInput } from './bridgeUrl';

const legacyHostBridgeUrl = normalizeBridgeUrlInput(
  process.env.EXPO_PUBLIC_HOST_BRIDGE_URL ??
    process.env.EXPO_PUBLIC_MAC_BRIDGE_URL ??
    ''
);
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

if (legacyHostBridgeUrl && isInsecureRemoteUrl(legacyHostBridgeUrl) && !allowInsecureRemoteBridge) {
  console.warn(
    'Using build-time bridge URL fallback from env. Configure bridge URL in-app from onboarding/settings when possible.'
  );
}

export const env = {
  legacyHostBridgeUrl,
  hostBridgeToken,
  allowWsQueryTokenAuth,
  allowInsecureRemoteBridge,
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
