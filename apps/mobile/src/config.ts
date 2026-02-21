const macBridgeUrl =
  process.env.EXPO_PUBLIC_MAC_BRIDGE_URL?.replace(/\/$/, '') ??
  'http://127.0.0.1:8787';
const macBridgeToken = process.env.EXPO_PUBLIC_MAC_BRIDGE_TOKEN?.trim() || null;
const allowWsQueryTokenAuth =
  process.env.EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH?.trim().toLowerCase() ===
  'true';
const allowInsecureRemoteBridge =
  process.env.EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE?.trim().toLowerCase() ===
  'true';
const privacyPolicyUrl = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim() || null;
const termsOfServiceUrl = process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL?.trim() || null;

if (isInsecureRemoteUrl(macBridgeUrl) && !allowInsecureRemoteBridge) {
  console.warn(
    'EXPO_PUBLIC_MAC_BRIDGE_URL uses http:// for a non-local host. Prefer https:// for remote bridge access.'
  );
}

export const env = {
  macBridgeUrl,
  macBridgeToken,
  allowWsQueryTokenAuth,
  privacyPolicyUrl,
  termsOfServiceUrl
};

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
