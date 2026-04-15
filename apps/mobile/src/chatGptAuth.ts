import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

const CHATGPT_AUTH_ISSUER = 'https://auth.openai.com';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALLBACK_SCHEME = 'clawdex';
const CALLBACK_HOST = 'auth';
const CALLBACK_PATH = '/callback';
const TOKEN_STORE_KEY = 'chatgpt-auth-tokens-v1';

export interface ChatGptAuthTokenBundle {
  accessToken: string;
  idToken: string;
  refreshToken: string | null;
  accountId: string;
  planType: string | null;
}

type ChatGptAuthSessionResult =
  | { kind: 'callback'; callbackUrl: URL; redirectUri: string }
  | { kind: 'cancelled' }
  | { kind: 'dismissed' }
  | { kind: 'error'; message: string };

export class ChatGptAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatGptAuthError';
  }
}

export async function loadStoredChatGptAuthTokens(): Promise<ChatGptAuthTokenBundle | null> {
  const raw = await SecureStore.getItemAsync(TOKEN_STORE_KEY);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await SecureStore.deleteItemAsync(TOKEN_STORE_KEY);
    return null;
  }

  return readTokenBundle(parsed);
}

export async function clearStoredChatGptAuthTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_STORE_KEY);
}

export async function loginWithChatGpt(): Promise<ChatGptAuthTokenBundle> {
  ensureSupportedPlatform();

  const state = Crypto.randomUUID();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const redirectUri = buildChatGptRedirectUri();
  const authUrl = buildAuthorizeUrl({
    state,
    codeChallenge,
    redirectUri,
  });
  const session = await openAuthSession(authUrl, redirectUri);
  if (session.kind === 'cancelled') {
    throw new ChatGptAuthError('ChatGPT login was cancelled.');
  }
  if (session.kind === 'dismissed') {
    throw new ChatGptAuthError('ChatGPT login did not complete.');
  }
  if (session.kind === 'error') {
    throw new ChatGptAuthError(session.message);
  }

  const tokens = await completeAuthorization({
    callbackUrl: session.callbackUrl,
    expectedState: state,
    codeVerifier,
    redirectUri: session.redirectUri,
  });
  await saveTokenBundle(tokens);
  return tokens;
}

export async function refreshStoredChatGptAuthTokens(
  previousAccountId?: string | null
): Promise<ChatGptAuthTokenBundle> {
  const stored = await loadStoredChatGptAuthTokens();
  if (!stored) {
    throw new ChatGptAuthError('No stored ChatGPT login is available.');
  }
  if (!stored.refreshToken) {
    throw new ChatGptAuthError('No ChatGPT refresh token is available.');
  }

  const refreshed = await exchangeRefreshToken(stored.refreshToken);
  if (
    previousAccountId &&
    previousAccountId.trim() &&
    refreshed.accountId !== previousAccountId &&
    stored.accountId !== previousAccountId
  ) {
    throw new ChatGptAuthError('ChatGPT refresh returned a different account.');
  }

  await saveTokenBundle(refreshed);
  return refreshed;
}

export async function getFreshChatGptAuthTokens(
  previousAccountId?: string | null
): Promise<ChatGptAuthTokenBundle> {
  try {
    return await refreshStoredChatGptAuthTokens(previousAccountId);
  } catch {
    return await loginWithChatGpt();
  }
}

export function isNativeChatGptLoginAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return false;
  }

  return Constants.appOwnership !== 'expo';
}

export function buildChatGptRedirectUri(): string {
  return `${CALLBACK_SCHEME}://${CALLBACK_HOST}${CALLBACK_PATH}`;
}

export function buildAuthorizeUrl(input: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const url = new URL('/oauth/authorize', CHATGPT_AUTH_ISSUER);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CHATGPT_CLIENT_ID);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', 'openid profile email offline_access');
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  return url.toString();
}

export function validateCallbackUrl(callbackUrl: URL): URL {
  const isCustomScheme =
    callbackUrl.protocol === `${CALLBACK_SCHEME}:` &&
    callbackUrl.hostname === CALLBACK_HOST &&
    callbackUrl.pathname === CALLBACK_PATH;
  const isLegacyLoopback =
    callbackUrl.protocol === 'http:' &&
    (callbackUrl.hostname === '127.0.0.1' || callbackUrl.hostname === 'localhost') &&
    callbackUrl.pathname === '/auth/callback';

  if (!isCustomScheme && !isLegacyLoopback) {
    throw new ChatGptAuthError('ChatGPT login returned an invalid callback URL.');
  }

  return callbackUrl;
}

export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = `${payload}${'='.repeat((4 - (payload.length % 4)) % 4)}`;
    const json = decodeBase64(padded);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const nested = parsed['https://api.openai.com/auth'];
    return isRecord(nested) ? nested : parsed;
  } catch {
    return {};
  }
}

function ensureSupportedPlatform() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new ChatGptAuthError(
      'ChatGPT login is currently available only on the iOS and Android app builds.'
    );
  }
  if (!isNativeChatGptLoginAvailable()) {
    throw new ChatGptAuthError(
      'ChatGPT login requires the installed native app build. Expo Go is not supported.'
    );
  }
}

async function saveTokenBundle(tokens: ChatGptAuthTokenBundle): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_STORE_KEY, JSON.stringify(tokens));
}

async function completeAuthorization(input: {
  callbackUrl: URL;
  expectedState: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ChatGptAuthTokenBundle> {
  const callbackUrl = validateCallbackUrl(input.callbackUrl);
  const state = callbackUrl.searchParams.get('state');
  const error = callbackUrl.searchParams.get('error');
  const errorDescription = callbackUrl.searchParams.get('error_description');

  if (error) {
    throw new ChatGptAuthError(errorDescription?.trim() || error);
  }
  if (state !== input.expectedState) {
    throw new ChatGptAuthError('ChatGPT login state did not match the original request.');
  }

  const code = callbackUrl.searchParams.get('code')?.trim();
  if (!code) {
    throw new ChatGptAuthError('ChatGPT login did not return an authorization code.');
  }

  return await exchangeAuthorizationCode({
    code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
  });
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ChatGptAuthTokenBundle> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);
  body.set('client_id', CHATGPT_CLIENT_ID);
  body.set('code_verifier', input.codeVerifier);
  return await exchangeToken(body);
}

async function exchangeRefreshToken(refreshToken: string): Promise<ChatGptAuthTokenBundle> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  body.set('client_id', CHATGPT_CLIENT_ID);
  return await exchangeToken(body);
}

async function exchangeToken(body: URLSearchParams): Promise<ChatGptAuthTokenBundle> {
  const response = await fetch(new URL('/oauth/token', CHATGPT_AUTH_ISSUER), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ChatGptAuthError(
      `ChatGPT token exchange failed (${response.status}): ${text.slice(0, 300)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ChatGptAuthError('ChatGPT token exchange returned invalid JSON.');
  }

  const record = asRecord(payload);
  const accessToken = readNonEmptyString(record.access_token);
  const idToken = readNonEmptyString(record.id_token);
  const refreshToken = readOptionalString(record.refresh_token);

  if (!accessToken || !idToken) {
    throw new ChatGptAuthError('ChatGPT token exchange did not return access_token and id_token.');
  }

  const idClaims = decodeJwtClaims(idToken);
  const accessClaims = decodeJwtClaims(accessToken);
  const accountId = resolveAccountId(idClaims, accessClaims);
  if (!accountId) {
    throw new ChatGptAuthError('ChatGPT login did not include an account identifier.');
  }

  return {
    accessToken,
    idToken,
    refreshToken,
    accountId,
    planType: resolvePlanType(idClaims, accessClaims),
  };
}

function resolveAccountId(
  idClaims: Record<string, unknown>,
  accessClaims: Record<string, unknown>
): string | null {
  const candidates = [
    readOptionalString(idClaims.chatgpt_account_id),
    readOptionalString(accessClaims.chatgpt_account_id),
    readOptionalString(idClaims.organization_id),
    readOptionalString(accessClaims.organization_id),
  ];

  return candidates.find((value) => Boolean(value)) ?? null;
}

function resolvePlanType(
  idClaims: Record<string, unknown>,
  accessClaims: Record<string, unknown>
): string | null {
  return (
    readOptionalString(accessClaims.chatgpt_plan_type) ??
    readOptionalString(idClaims.chatgpt_plan_type) ??
    null
  );
}

function createCodeVerifier(): string {
  const bytes = Crypto.getRandomBytes(32);
  return base64UrlEncodeBytes(bytes);
}

async function createCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    utf8Bytes(codeVerifier) as unknown as BufferSource
  );
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function openAuthSession(
  authorizeUrl: string,
  redirectUri: string
): Promise<ChatGptAuthSessionResult> {
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri, {
    preferEphemeralSession: true,
  });

  if (result.type === 'cancel') {
    return { kind: 'cancelled' };
  }
  if (result.type === 'dismiss') {
    return { kind: 'dismissed' };
  }
  if (result.type === 'success' && result.url) {
    return {
      kind: 'callback',
      callbackUrl: new URL(result.url),
      redirectUri,
    };
  }
  return {
    kind: 'error',
    message: result.type,
  };
}

function readTokenBundle(value: unknown): ChatGptAuthTokenBundle | null {
  const record = asRecord(value);
  const accessToken = readNonEmptyString(record.accessToken);
  const idToken = readNonEmptyString(record.idToken);
  const accountId = readNonEmptyString(record.accountId);

  if (!accessToken || !idToken || !accountId) {
    return null;
  }

  return {
    accessToken,
    idToken,
    accountId,
    refreshToken: readOptionalString(record.refreshToken),
    planType: readOptionalString(record.planType),
  };
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionalString(value: unknown): string | null {
  return readNonEmptyString(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return encodeBase64(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodeBase64(value: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(value);
  }

  return Buffer.from(value, 'binary').toString('base64');
}

function decodeBase64(value: string): string {
  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(value);
  }

  return Buffer.from(value, 'base64').toString('binary');
}
