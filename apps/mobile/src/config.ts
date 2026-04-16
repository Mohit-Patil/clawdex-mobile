import { isInsecureRemoteUrl, normalizeBridgeUrlInput } from './bridgeUrl';

const defaultPrivacyPolicyUrl =
  'https://mohit-patil.github.io/clawdex-mobile/privacy/';
const defaultTermsOfServiceUrl =
  'https://mohit-patil.github.io/clawdex-mobile/terms/';

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
const privacyPolicyUrl =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim() || defaultPrivacyPolicyUrl;
const termsOfServiceUrl =
  process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL?.trim() || defaultTermsOfServiceUrl;
const revenueCatIosApiKey =
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.trim() || null;
const revenueCatAndroidApiKey =
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY?.trim() || null;
const revenueCatTestStoreApiKey =
  process.env.EXPO_PUBLIC_REVENUECAT_TEST_STORE_API_KEY?.trim() || null;
const revenueCatTipsOfferingId =
  process.env.EXPO_PUBLIC_REVENUECAT_TIPS_OFFERING_ID?.trim() || null;
const githubClientId = process.env.EXPO_PUBLIC_GITHUB_APP_CLIENT_ID?.trim() || null;
const githubAppSlug = process.env.EXPO_PUBLIC_GITHUB_APP_SLUG?.trim() || null;
const githubCodespacesPortForwardingDomain =
  process.env.EXPO_PUBLIC_GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim() ||
  'app.github.dev';
const githubCodespacesPreferredRepositoryName =
  process.env.EXPO_PUBLIC_GITHUB_CODESPACES_REPO_NAME?.trim() || 'clawdex-codespace';
const githubCodespacesSourceRepositoryOwner =
  process.env.EXPO_PUBLIC_GITHUB_CODESPACES_SOURCE_OWNER?.trim() || null;
const githubCodespacesRepositoryRef =
  process.env.EXPO_PUBLIC_GITHUB_CODESPACES_REPO_REF?.trim() || null;
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
  termsOfServiceUrl,
  revenueCatIosApiKey,
  revenueCatAndroidApiKey,
  revenueCatTestStoreApiKey,
  revenueCatTipsOfferingId,
  githubClientId,
  githubAppSlug,
  githubCodespacesPortForwardingDomain,
  githubCodespacesPreferredRepositoryName,
  githubCodespacesSourceRepositoryOwner,
  githubCodespacesRepositoryRef,
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
