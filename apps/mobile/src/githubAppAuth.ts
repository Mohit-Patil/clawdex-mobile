import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import type { GitHubUserAccessToken } from './githubCodespaces';

const TOKEN_STORE_KEY = 'github-app-auth-tokens-v1';
const CALLBACK_SCHEME = 'clawdex';
const CALLBACK_HOST = 'github';
const CALLBACK_PATH = '/callback';

type GitHubAppAuthSessionResult =
  | { kind: 'callback'; callbackUrl: URL }
  | { kind: 'cancelled' }
  | { kind: 'dismissed' }
  | { kind: 'error'; message: string };

export class GitHubAppAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppAuthError';
  }
}

export async function loadStoredGitHubAppAuthTokens(): Promise<GitHubUserAccessToken | null> {
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

  const token = readGitHubUserAccessToken(asRecord(parsed));
  if (!token) {
    await SecureStore.deleteItemAsync(TOKEN_STORE_KEY);
    return null;
  }
  return token;
}

export async function saveStoredGitHubAppAuthTokens(
  token: GitHubUserAccessToken
): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_STORE_KEY, JSON.stringify(token));
}

export async function clearStoredGitHubAppAuthTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_STORE_KEY);
}

export async function loginWithGitHubApp(options: {
  appSlug: string;
  authBaseUrl: string;
}): Promise<GitHubUserAccessToken> {
  ensureSupportedPlatform();

  const appSlug = options.appSlug.trim();
  const authBaseUrl = normalizeBaseUrl(options.authBaseUrl);
  if (!appSlug) {
    throw new GitHubAppAuthError('GitHub App slug is not configured.');
  }
  if (!authBaseUrl) {
    throw new GitHubAppAuthError('GitHub auth backend URL is not configured.');
  }

  const state = Crypto.randomUUID();
  const authorizeUrl = buildGitHubAppInstallUrl(appSlug, state);
  const redirectUri = buildGitHubAppRedirectUri();
  const session = await openAuthSession(authorizeUrl, redirectUri);
  if (session.kind === 'cancelled') {
    throw new GitHubAppAuthError('GitHub login was cancelled.');
  }
  if (session.kind === 'dismissed') {
    throw new GitHubAppAuthError('GitHub login did not complete.');
  }
  if (session.kind === 'error') {
    throw new GitHubAppAuthError(session.message);
  }

  const token = await completeAuthorization({
    callbackUrl: session.callbackUrl,
    expectedState: state,
    authBaseUrl,
  });
  await saveStoredGitHubAppAuthTokens(token);
  return token;
}

export async function refreshStoredGitHubAppAuthTokens(
  authBaseUrl: string,
  fallbackRefreshToken?: string | null
): Promise<GitHubUserAccessToken> {
  const stored = await loadStoredGitHubAppAuthTokens();
  const refreshToken = normalizeString(fallbackRefreshToken) ?? stored?.refreshToken ?? null;
  if (!refreshToken) {
    throw new GitHubAppAuthError('No GitHub refresh token is available.');
  }

  const token = await refreshGitHubAppAuthTokens(authBaseUrl, refreshToken);
  await saveStoredGitHubAppAuthTokens(token);
  return token;
}

export function buildGitHubAppRedirectUri(): string {
  return `${CALLBACK_SCHEME}://${CALLBACK_HOST}${CALLBACK_PATH}`;
}

export function validateGitHubAppCallbackUrl(callbackUrl: URL): URL {
  const isCustomScheme =
    callbackUrl.protocol === `${CALLBACK_SCHEME}:` &&
    callbackUrl.hostname === CALLBACK_HOST &&
    callbackUrl.pathname === CALLBACK_PATH;

  if (!isCustomScheme) {
    throw new GitHubAppAuthError('GitHub login returned an invalid callback URL.');
  }

  return callbackUrl;
}

function buildGitHubAppInstallUrl(appSlug: string, state: string): string {
  const url = new URL(`/apps/${appSlug}/installations/new`, 'https://github.com');
  url.searchParams.set('state', state);
  return url.toString();
}

async function completeAuthorization(input: {
  callbackUrl: URL;
  expectedState: string;
  authBaseUrl: string;
}): Promise<GitHubUserAccessToken> {
  const callbackUrl = validateGitHubAppCallbackUrl(input.callbackUrl);
  const state = normalizeString(callbackUrl.searchParams.get('state'));
  const error = normalizeString(callbackUrl.searchParams.get('error'));
  const errorDescription = normalizeString(callbackUrl.searchParams.get('error_description'));
  if (error) {
    throw new GitHubAppAuthError(errorDescription ?? error);
  }
  if (state !== input.expectedState) {
    throw new GitHubAppAuthError('GitHub login state did not match the original request.');
  }

  const code = normalizeString(callbackUrl.searchParams.get('code'));
  if (!code) {
    throw new GitHubAppAuthError(
      'GitHub login completed without an authorization code. Make sure the GitHub App has "Request user authorization (OAuth) during installation" enabled.'
    );
  }

  return await exchangeAuthorizationCode(input.authBaseUrl, code);
}

async function exchangeAuthorizationCode(
  authBaseUrl: string,
  code: string
): Promise<GitHubUserAccessToken> {
  const payload = await postAuthRequest(authBaseUrl, '/api/github/exchange', {
    code,
  });
  const token = readGitHubUserAccessToken(asRecord(payload));
  if (!token) {
    throw new GitHubAppAuthError('GitHub token exchange returned an invalid token payload.');
  }
  return token;
}

export async function refreshGitHubAppAuthTokens(
  authBaseUrl: string,
  refreshToken: string
): Promise<GitHubUserAccessToken> {
  const payload = await postAuthRequest(authBaseUrl, '/api/github/refresh', {
    refreshToken,
  });
  const token = readGitHubUserAccessToken(asRecord(payload));
  if (!token) {
    throw new GitHubAppAuthError('GitHub token refresh returned an invalid token payload.');
  }
  return token;
}

async function postAuthRequest(
  authBaseUrl: string,
  path: string,
  body: Record<string, string>
): Promise<unknown> {
  const response = await fetch(new URL(path, ensureTrailingSlash(authBaseUrl)), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubAppAuthError(
      readGitHubErrorMessage(payload) ?? `GitHub auth request failed (${response.status}).`
    );
  }
  return payload;
}

async function openAuthSession(
  authorizeUrl: string,
  redirectUri: string
): Promise<GitHubAppAuthSessionResult> {
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri);
  if (result.type === 'cancel') {
    return { kind: 'cancelled' };
  }
  if (result.type === 'dismiss') {
    return { kind: 'dismissed' };
  }
  if (result.type === 'success' && result.url) {
    return { kind: 'callback', callbackUrl: new URL(result.url) };
  }
  return {
    kind: 'error',
    message: result.type,
  };
}

function ensureSupportedPlatform(): void {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new GitHubAppAuthError(
      'GitHub login is currently available only on the iOS and Android app builds.'
    );
  }
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function readGitHubUserAccessToken(
  record: Record<string, unknown> | null
): GitHubUserAccessToken | null {
  const accessToken = normalizeString(record?.access_token);
  if (!accessToken) {
    return null;
  }

  const issuedAtMs = Date.now();
  const tokenType = normalizeString(record?.token_type) ?? 'bearer';
  const expiresInSec = readOptionalNumber(record?.expires_in);
  const refreshTokenExpiresInSec = readOptionalNumber(record?.refresh_token_expires_in);

  return {
    accessToken,
    scope: normalizeScope(record?.scope),
    tokenType,
    refreshToken: normalizeString(record?.refresh_token),
    expiresInSec,
    accessTokenExpiresAtMs: expiresInSec !== null ? issuedAtMs + expiresInSec * 1000 : null,
    refreshTokenExpiresInSec,
    refreshTokenExpiresAtMs:
      refreshTokenExpiresInSec !== null
        ? issuedAtMs + refreshTokenExpiresInSec * 1000
        : null,
  };
}

function normalizeScope(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readGitHubErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return normalizeString(record?.error_description) ?? normalizeString(record?.message);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
