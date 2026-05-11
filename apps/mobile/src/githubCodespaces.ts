import { isGitHubBridgeProfile, type BridgeProfile } from './bridgeProfiles';

const GITHUB_OAUTH_BASE_URL = 'https://github.com';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_ACCESS_TOKEN_REFRESH_BUFFER_MS = 90_000;
const GITHUB_CODESPACE_DEFAULT_IDLE_TIMEOUT_MINUTES = 45;
const GITHUB_INSTALLATION_TOKEN_TIMEOUT_MS = 30_000;
const GITHUB_CODESPACES_PORT_PUBLIC_TIMEOUT_MS = 30_000;
const GITHUB_CODESPACES_PORT_PUBLIC_POLL_MS = 1_000;

export interface GitHubDeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface GitHubUserAccessToken {
  accessToken: string;
  scope: string[];
  tokenType: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  accessTokenExpiresAtMs: number | null;
  refreshTokenExpiresInSec: number | null;
  refreshTokenExpiresAtMs: number | null;
}

export interface GitHubAppInstallation {
  id: number;
  accountLogin: string | null;
  accountId: number | null;
  targetType: string | null;
  repositorySelection: 'all' | 'selected' | null;
  htmlUrl: string | null;
}

export interface GitHubAppInstallationRepository {
  id: number;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  permissions: string[];
  canReadContents: boolean;
  canWriteContents: boolean;
}

export interface GitHubAppAccessSnapshot {
  installations: GitHubAppInstallation[];
  repositories: GitHubAppInstallationRepository[];
}

export interface GitHubInstallationAccessToken {
  accessToken: string;
  installationId: number;
  repositoryNames: string[];
  expiresAt: string | null;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubCodespace {
  name: string;
  state: string;
  webUrl: string | null;
  lastUsedAt: string | null;
  updatedAt: string | null;
  repositoryFullName: string | null;
  repositoryName: string | null;
  ownerLogin: string | null;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface GitHubCodespacesRepositoryReference {
  owner: string;
  repo: string;
  fullName: string;
  source: 'user' | 'fallback';
}

export interface GitHubRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  isFork: boolean;
}

export interface GitHubCodespaceDefaults {
  devcontainerPath: string | null;
  location: string | null;
}

export interface GitHubCodespaceCreationContext {
  repository: GitHubCodespacesRepositoryReference;
  defaults: GitHubCodespaceDefaults;
  createdFork: boolean;
}

export type GitHubDeviceTokenPollResult =
  | { kind: 'authorized'; token: GitHubUserAccessToken }
  | { kind: 'pending'; intervalSec: number }
  | { kind: 'denied'; message: string }
  | { kind: 'expired'; message: string };

export async function requestGitHubDeviceCode(
  clientId: string,
  scopes: string[] = []
): Promise<GitHubDeviceCodeGrant> {
  const trimmedClientId = clientId.trim();
  if (!trimmedClientId) {
    throw new Error('GitHub client ID is not configured.');
  }

  const body = new URLSearchParams({
    client_id: trimmedClientId,
  });
  const normalizedScope = scopes.join(' ').trim();
  if (normalizedScope) {
    body.set('scope', normalizedScope);
  }
  const response = await fetch(`${GITHUB_OAUTH_BASE_URL}/login/device/code`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(readGitHubErrorMessage(payload) ?? `GitHub device code failed (${response.status})`);
  }

  const record = asRecord(payload);
  const deviceCode = readRequiredString(record, 'device_code');
  const userCode = readRequiredString(record, 'user_code');
  const verificationUri = readRequiredString(record, 'verification_uri');
  const expiresInSec = readRequiredNumber(record, 'expires_in');
  const intervalSec = readRequiredNumber(record, 'interval');
  const issuedAtMs = Date.now();

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSec,
    intervalSec,
    issuedAtMs,
    expiresAtMs: issuedAtMs + expiresInSec * 1000,
  };
}

export async function pollGitHubDeviceAccessToken(
  clientId: string,
  deviceCode: string
): Promise<GitHubDeviceTokenPollResult> {
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    device_code: deviceCode.trim(),
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const response = await fetch(`${GITHUB_OAUTH_BASE_URL}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const payload = await readJsonResponse(response);
  const record = asRecord(payload);
  const errorCode = readOptionalString(record, 'error');
  if (errorCode === 'authorization_pending') {
    return {
      kind: 'pending',
      intervalSec: readOptionalNumber(record, 'interval') ?? 5,
    };
  }
  if (errorCode === 'slow_down') {
    return {
      kind: 'pending',
      intervalSec: readOptionalNumber(record, 'interval') ?? 10,
    };
  }
  if (errorCode === 'access_denied') {
    return {
      kind: 'denied',
      message: readGitHubErrorMessage(payload) ?? 'GitHub sign-in was cancelled.',
    };
  }
  if (errorCode === 'expired_token' || errorCode === 'token_expired') {
    return {
      kind: 'expired',
      message: readGitHubErrorMessage(payload) ?? 'GitHub device code expired. Start again.',
    };
  }
  if (!response.ok) {
    throw new Error(readGitHubErrorMessage(payload) ?? `GitHub token exchange failed (${response.status})`);
  }

  return {
    kind: 'authorized',
    token: readGitHubUserAccessToken(record),
  };
}

export async function refreshGitHubUserAccessToken(
  clientId: string,
  refreshToken: string
): Promise<GitHubUserAccessToken> {
  const trimmedClientId = clientId.trim();
  const trimmedRefreshToken = refreshToken.trim();
  if (!trimmedClientId) {
    throw new Error('GitHub client ID is not configured.');
  }
  if (!trimmedRefreshToken) {
    throw new Error('GitHub refresh token is not available.');
  }

  const body = new URLSearchParams({
    client_id: trimmedClientId,
    grant_type: 'refresh_token',
    refresh_token: trimmedRefreshToken,
  });
  const response = await fetch(`${GITHUB_OAUTH_BASE_URL}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(readGitHubErrorMessage(payload) ?? `GitHub token refresh failed (${response.status})`);
  }

  return readGitHubUserAccessToken(asRecord(payload));
}

export function isRetryableGitHubDeviceFlowError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized === 'network request failed' ||
    normalized.includes('the internet connection appears to be offline') ||
    normalized.includes('network connection was lost') ||
    normalized.includes('networkerror') ||
    normalized.includes('load failed')
  );
}

export function shouldRefreshGitHubUserAccessToken(
  token: Pick<GitHubUserAccessToken, 'accessTokenExpiresAtMs' | 'refreshToken' | 'refreshTokenExpiresAtMs'>,
  now = Date.now()
): boolean {
  if (!token.refreshToken?.trim()) {
    return false;
  }
  if (token.refreshTokenExpiresAtMs !== null && token.refreshTokenExpiresAtMs <= now) {
    return false;
  }
  if (token.accessTokenExpiresAtMs === null) {
    return false;
  }

  return token.accessTokenExpiresAtMs <= now + GITHUB_ACCESS_TOKEN_REFRESH_BUFFER_MS;
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const payload = await githubApiRequest('/user', accessToken);
  const record = asRecord(payload);
  return {
    login: readRequiredString(record, 'login'),
    id: readRequiredNumber(record, 'id'),
    name: readOptionalString(record, 'name'),
    avatarUrl: readOptionalString(record, 'avatar_url'),
  };
}

export async function fetchGitHubAppInstallations(
  accessToken: string
): Promise<GitHubAppInstallation[]> {
  const installations: unknown[] = [];
  const perPage = 100;
  for (let page = 1; ; page += 1) {
    const payload = await githubApiRequest(
      `/user/installations?per_page=${String(perPage)}&page=${String(page)}`,
      accessToken
    );
    const record = asRecord(payload);
    const pageInstallations =
      record && Array.isArray(record.installations) ? record.installations : [];
    installations.push(...pageInstallations);
    if (pageInstallations.length < perPage) {
      break;
    }
  }

  return installations
    .map((entry) => normalizeGitHubAppInstallation(entry))
    .filter((entry): entry is GitHubAppInstallation => entry !== null);
}

export async function fetchGitHubAppInstallationRepositories(
  accessToken: string,
  installationId: number
): Promise<GitHubAppInstallationRepository[]> {
  const repositories: unknown[] = [];
  const perPage = 100;
  for (let page = 1; ; page += 1) {
    const payload = await githubApiRequest(
      `/user/installations/${String(installationId)}/repositories?per_page=${String(perPage)}&page=${String(page)}`,
      accessToken
    );
    const record = asRecord(payload);
    const pageRepositories =
      record && Array.isArray(record.repositories) ? record.repositories : [];
    repositories.push(...pageRepositories);
    if (pageRepositories.length < perPage) {
      break;
    }
  }

  return repositories
    .map((entry) => normalizeGitHubAppInstallationRepository(entry, installationId))
    .filter((entry): entry is GitHubAppInstallationRepository => entry !== null);
}

export async function fetchGitHubAppAccessSnapshot(
  accessToken: string
): Promise<GitHubAppAccessSnapshot> {
  const installations = await fetchGitHubAppInstallations(accessToken);
  const repositories = (
    await Promise.all(
      installations.map(async (installation) => {
        try {
          return await fetchGitHubAppInstallationRepositories(accessToken, installation.id);
        } catch {
          return [];
        }
      })
    )
  ).flat();

  const uniqueRepositories = new Map<string, GitHubAppInstallationRepository>();
  repositories.forEach((repository) => {
    if (!repository.canReadContents || !repository.canWriteContents) {
      return;
    }
    uniqueRepositories.set(repository.fullName.toLowerCase(), repository);
  });

  return {
    installations,
    repositories: [...uniqueRepositories.values()],
  };
}

export async function requestGitHubInstallationAccessToken(input: {
  authBaseUrl: string;
  userAccessToken: string;
  installationId: number;
  repositories: string[];
  timeoutMs?: number;
}): Promise<GitHubInstallationAccessToken> {
  const authBaseUrl = input.authBaseUrl.trim();
  const userAccessToken = input.userAccessToken.trim();
  if (!authBaseUrl) {
    throw new Error('GitHub auth backend URL is not configured.');
  }
  if (!userAccessToken) {
    throw new Error('GitHub user access token is required.');
  }

  const repositories = input.repositories
    .map((repository) => repository.trim())
    .filter((repository) => repository.length > 0);
  if (repositories.length === 0) {
    throw new Error('At least one repository is required to request an installation token.');
  }

  const abortController = new AbortController();
  const timeoutMs = input.timeoutMs ?? GITHUB_INSTALLATION_TOKEN_TIMEOUT_MS;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(
      new URL('/api/github/installations/token', ensureTrailingSlash(authBaseUrl)),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userAccessToken,
          installationId: input.installationId,
          repositories,
        }),
        signal: abortController.signal,
      }
    );
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('GitHub repository access took too long. Try again or start fresh.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      readGitHubErrorMessage(payload) ?? `GitHub installation token request failed (${response.status})`
    );
  }

  const record = asRecord(payload);
  const accessToken = readRequiredString(record, 'access_token');
  const installationId = readRequiredNumber(record, 'installation_id');
  const repositoryNames = Array.isArray(record?.repositories)
    ? record.repositories.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (!accessToken || !installationId || repositoryNames.length === 0) {
    throw new Error('GitHub installation token response was invalid.');
  }

  return {
    accessToken,
    installationId,
    repositoryNames,
    expiresAt: readOptionalString(record, 'expires_at'),
  };
}

export async function fetchGitHubCodespaces(accessToken: string): Promise<GitHubCodespace[]> {
  const codespaces: unknown[] = [];
  const perPage = 100;
  for (let page = 1; ; page += 1) {
    const payload = await githubApiRequest(
      `/user/codespaces?per_page=${String(perPage)}&page=${String(page)}`,
      accessToken
    );
    const record = asRecord(payload);
    const pageCodespaces = record && Array.isArray(record.codespaces) ? record.codespaces : [];
    codespaces.push(...pageCodespaces);
    if (pageCodespaces.length < perPage) {
      break;
    }
  }

  return codespaces
    .map((entry) => normalizeGitHubCodespace(entry))
    .filter((entry): entry is GitHubCodespace => entry !== null);
}

export async function fetchGitHubCodespace(
  accessToken: string,
  codespaceName: string
): Promise<GitHubCodespace> {
  const payload = await githubApiRequest(
    `/user/codespaces/${encodeURIComponent(codespaceName)}`,
    accessToken
  );
  const normalized = normalizeGitHubCodespace(payload);
  if (!normalized) {
    throw new Error('GitHub returned an invalid Codespace payload.');
  }
  return normalized;
}

export async function startGitHubCodespace(
  accessToken: string,
  codespaceName: string
): Promise<void> {
  await githubApiRequest(`/user/codespaces/${encodeURIComponent(codespaceName)}/start`, accessToken, {
    method: 'POST',
  });
}

export async function stopGitHubCodespace(
  accessToken: string,
  codespaceName: string
): Promise<void> {
  await githubApiRequest(`/user/codespaces/${encodeURIComponent(codespaceName)}/stop`, accessToken, {
    method: 'POST',
  });
}

export async function publishGitHubCodespacePorts(
  accessToken: string,
  codespaceName: string,
  ports: number[]
): Promise<void> {
  const normalizedPorts = [...new Set(
    ports.filter((port) => Number.isFinite(port) && port > 0).map((port) => Math.trunc(port))
  )];
  if (normalizedPorts.length === 0) {
    return;
  }

  const payload = await githubApiRequest(
    `/user/codespaces/${encodeURIComponent(codespaceName)}?internal=true&refresh=true`,
    accessToken
  );
  const record = asRecord(payload);
  const connection = asRecord(record?.connection);
  const tunnel = asRecord(connection?.tunnelProperties);
  const tunnelId = readRequiredString(tunnel, 'tunnelId');
  const clusterId = readOptionalString(tunnel, 'clusterId');
  const managePortsAccessToken = readRequiredString(tunnel, 'managePortsAccessToken');
  const serviceUri = readOptionalString(tunnel, 'serviceUri');
  const baseUrl = resolveGitHubTunnelApiBaseUrl(clusterId, serviceUri);

  await Promise.all(
    normalizedPorts.map((port) =>
      publishGitHubCodespacePort(baseUrl, tunnelId, managePortsAccessToken, port)
    )
  );
  await waitForGitHubCodespacePortsPublic(
    baseUrl,
    tunnelId,
    managePortsAccessToken,
    normalizedPorts
  );
}

export async function deleteGitHubCodespace(
  accessToken: string,
  codespaceName: string
): Promise<void> {
  await githubApiRequest(`/user/codespaces/${encodeURIComponent(codespaceName)}`, accessToken, {
    method: 'DELETE',
  });
}

export async function fetchGitHubCodespaceDefaults(
  accessToken: string,
  repository: GitHubCodespacesRepositoryReference,
  ref?: string | null
): Promise<GitHubCodespaceDefaults> {
  const params = new URLSearchParams();
  const normalizedRef = ref?.trim();
  if (normalizedRef) {
    params.set('ref', normalizedRef);
  }

  const query = params.toString();
  const payload = await githubApiRequest(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/codespaces/new${
      query ? `?${query}` : ''
    }`,
    accessToken
  );
  const record = asRecord(payload);
  const defaultsRecord = asRecord(record?.defaults);

  return {
    devcontainerPath:
      readOptionalString(record, 'devcontainer_path') ??
      readOptionalString(defaultsRecord, 'devcontainer_path'),
    location: readOptionalString(defaultsRecord, 'location'),
  };
}

export async function fetchGitHubRepository(
  accessToken: string,
  repository: GitHubCodespacesRepositoryReference
): Promise<GitHubRepository> {
  const payload = await githubApiRequest(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
    accessToken
  );
  const normalized = normalizeGitHubRepository(payload);
  if (!normalized) {
    throw new Error('GitHub returned an invalid repository payload.');
  }
  return normalized;
}

export async function forkGitHubRepositoryForAuthenticatedUser(
  accessToken: string,
  repository: GitHubCodespacesRepositoryReference
): Promise<GitHubRepository> {
  const payload = await githubApiRequest(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/forks`,
    accessToken,
    {
      method: 'POST',
      body: {
        default_branch_only: false,
      },
    }
  );
  const normalized = normalizeGitHubRepository(payload);
  if (!normalized) {
    throw new Error('GitHub returned an invalid fork payload.');
  }
  return normalized;
}

export async function waitForGitHubRepositoryReady(
  accessToken: string,
  repository: GitHubCodespacesRepositoryReference,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {}
): Promise<GitHubRepository> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const startedAt = Date.now();
  let lastError: string | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await fetchGitHubRepository(accessToken, repository);
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(intervalMs);
  }

  throw new Error(lastError ?? 'Timed out while waiting for the forked repository to become ready.');
}

export async function createGitHubCodespaceInRepository(
  accessToken: string,
  repository: GitHubCodespacesRepositoryReference,
  options: {
    ref?: string | null;
    devcontainerPath?: string | null;
    location?: string | null;
    idleTimeoutMinutes?: number | null;
  } = {}
): Promise<GitHubCodespace> {
  const body: Record<string, number | string> = {
    idle_timeout_minutes:
      normalizeGitHubCodespaceIdleTimeoutMinutes(options.idleTimeoutMinutes) ??
      GITHUB_CODESPACE_DEFAULT_IDLE_TIMEOUT_MINUTES,
  };
  const normalizedRef = options.ref?.trim();
  if (normalizedRef) {
    body.ref = normalizedRef;
  }
  const normalizedDevcontainerPath = options.devcontainerPath?.trim();
  if (normalizedDevcontainerPath) {
    body.devcontainer_path = normalizedDevcontainerPath;
  }
  const normalizedLocation = options.location?.trim();
  if (normalizedLocation) {
    body.location = normalizedLocation;
  }

  const payload = await githubApiRequest(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/codespaces`,
    accessToken,
    {
      method: 'POST',
      body: body,
    }
  );
  const normalized = normalizeGitHubCodespace(payload);
  if (!normalized) {
    throw new Error('GitHub returned an invalid Codespace creation payload.');
  }
  return normalized;
}

export async function createGitHubCodespaceForAuthenticatedUser(
  accessToken: string,
  repositoryId: number,
  options: {
    ref?: string | null;
    devcontainerPath?: string | null;
    location?: string | null;
    idleTimeoutMinutes?: number | null;
  } = {}
): Promise<GitHubCodespace> {
  if (!Number.isFinite(repositoryId) || repositoryId <= 0) {
    throw new Error('GitHub repository ID is not available for Codespace creation.');
  }

  const body: Record<string, number | string> = {
    repository_id: repositoryId,
    idle_timeout_minutes:
      normalizeGitHubCodespaceIdleTimeoutMinutes(options.idleTimeoutMinutes) ??
      GITHUB_CODESPACE_DEFAULT_IDLE_TIMEOUT_MINUTES,
  };
  const normalizedRef = options.ref?.trim();
  if (normalizedRef) {
    body.ref = normalizedRef;
  }
  const normalizedDevcontainerPath = options.devcontainerPath?.trim();
  if (normalizedDevcontainerPath) {
    body.devcontainer_path = normalizedDevcontainerPath;
  }
  const normalizedLocation = options.location?.trim();
  if (normalizedLocation) {
    body.location = normalizedLocation;
  }

  const payload = await githubApiRequest('/user/codespaces', accessToken, {
    method: 'POST',
    body,
  });
  const normalized = normalizeGitHubCodespace(payload);
  if (!normalized) {
    throw new Error('GitHub returned an invalid Codespace creation payload.');
  }
  return normalized;
}

export function buildGitHubCodespacesRepositoryCandidates(
  userLogin: string,
  repoName: string,
  sourceOwner?: string | null
): GitHubCodespacesRepositoryReference[] {
  const normalizedRepoName = repoName.trim();
  const normalizedUserLogin = userLogin.trim();
  const normalizedSourceOwner = sourceOwner?.trim() ?? '';
  if (!normalizedRepoName || !normalizedUserLogin) {
    return [];
  }

  const candidates: GitHubCodespacesRepositoryReference[] = [
    {
      owner: normalizedUserLogin,
      repo: normalizedRepoName,
      fullName: `${normalizedUserLogin}/${normalizedRepoName}`,
      source: 'user',
    },
  ];

  if (
    normalizedSourceOwner &&
    normalizedSourceOwner.toLowerCase() !== normalizedUserLogin.toLowerCase()
  ) {
    candidates.push({
      owner: normalizedSourceOwner,
      repo: normalizedRepoName,
      fullName: `${normalizedSourceOwner}/${normalizedRepoName}`,
      source: 'fallback',
    });
  }

  return candidates;
}

export async function resolveGitHubCodespaceCreationContext(
  accessToken: string,
  options: {
    userLogin: string;
    repoName: string;
    sourceOwner?: string | null;
    ref?: string | null;
  }
): Promise<GitHubCodespaceCreationContext> {
  const candidates = buildGitHubCodespacesRepositoryCandidates(
    options.userLogin,
    options.repoName,
    options.sourceOwner
  );
  if (candidates.length === 0) {
    throw new Error('No repository is configured for Codespace creation.');
  }

  let lastError: string | null = null;
  for (const repository of candidates) {
    try {
      const defaults = await fetchGitHubCodespaceDefaults(accessToken, repository, options.ref);
      return {
        repository,
        defaults,
        createdFork: false,
      };
    } catch (error) {
      lastError = (error as Error).message;
    }
  }

  const fallbackRepository = candidates.find((candidate) => candidate.source === 'fallback') ?? null;
  const userRepository = candidates.find((candidate) => candidate.source === 'user') ?? null;
  if (fallbackRepository && userRepository) {
    try {
      await forkGitHubRepositoryForAuthenticatedUser(accessToken, fallbackRepository);
      await waitForGitHubRepositoryReady(accessToken, userRepository);
      const defaults = await fetchGitHubCodespaceDefaults(accessToken, userRepository, options.ref);
      return {
        repository: userRepository,
        defaults,
        createdFork: true,
      };
    } catch (error) {
      lastError = (error as Error).message;
    }
  }

  if (lastError) {
    throw new Error(lastError);
  }

  throw new Error('Unable to resolve a repository for Codespace creation.');
}

export function buildGitHubCodespacesBridgeUrl(
  codespaceName: string,
  portForwardingDomain: string,
  port = 8787
): string | null {
  const normalizedCodespaceName = codespaceName.trim();
  const normalizedDomain = normalizePortForwardingDomain(portForwardingDomain);
  if (!normalizedCodespaceName || !normalizedDomain || !Number.isFinite(port) || port <= 0) {
    return null;
  }

  return `https://${normalizedCodespaceName}-${String(port)}.${normalizedDomain}`;
}

export function buildGitHubAppInstallUrl(appSlug: string, state?: string | null): string | null {
  const normalizedAppSlug = appSlug.trim();
  if (!normalizedAppSlug) {
    return null;
  }

  const url = new URL(`/apps/${normalizedAppSlug}/installations/new`, GITHUB_OAUTH_BASE_URL);
  const normalizedState = state?.trim();
  if (normalizedState) {
    url.searchParams.set('state', normalizedState);
  }
  return url.toString();
}

export function hasGitHubAppRepositoryAccess(
  snapshot: Pick<GitHubAppAccessSnapshot, 'repositories'> | null | undefined,
  repositoryFullName: string | null | undefined
): boolean {
  const normalizedFullName = repositoryFullName?.trim().toLowerCase();
  if (!normalizedFullName) {
    return false;
  }

  return (
    snapshot?.repositories.some(
      (repository) =>
        repository.fullName.trim().toLowerCase() === normalizedFullName &&
        repository.canReadContents &&
        repository.canWriteContents
    ) ?? false
  );
}

export function getReusableGitHubBridgeProfile(
  profiles: BridgeProfile[],
  activeProfileId?: string | null
): BridgeProfile | null {
  const githubProfiles = profiles.filter((profile) => isGitHubBridgeProfile(profile));
  if (githubProfiles.length === 0) {
    return null;
  }

  if (activeProfileId) {
    const activeProfile = githubProfiles.find((profile) => profile.id === activeProfileId);
    if (activeProfile) {
      return activeProfile;
    }
  }

  return [...githubProfiles].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function sortGitHubCodespaces(
  codespaces: GitHubCodespace[],
  preferredRepositoryName: string | null
): GitHubCodespace[] {
  const preferred = preferredRepositoryName?.trim().toLowerCase() || null;
  return [...codespaces].sort((left, right) => {
    const preferredLeft = isPreferredCodespace(left, preferred);
    const preferredRight = isPreferredCodespace(right, preferred);
    if (preferredLeft !== preferredRight) {
      return preferredLeft ? -1 : 1;
    }

    const availableLeft = left.state.trim().toLowerCase() === 'available';
    const availableRight = right.state.trim().toLowerCase() === 'available';
    if (availableLeft !== availableRight) {
      return availableLeft ? -1 : 1;
    }

    const leftStamp = left.lastUsedAt ?? left.updatedAt ?? '';
    const rightStamp = right.lastUsedAt ?? right.updatedAt ?? '';
    return rightStamp.localeCompare(leftStamp);
  });
}

export function findReusableGitHubCodespace(
  codespaces: GitHubCodespace[],
  options: {
    preferredRepositoryName: string | null;
    preferredOwnerLogin?: string | null;
    fallbackOwnerLogin?: string | null;
  }
): GitHubCodespace | null {
  const preferredRepositoryName = options.preferredRepositoryName?.trim().toLowerCase() || null;
  if (!preferredRepositoryName) {
    return null;
  }

  const preferredOwnerLogin = options.preferredOwnerLogin?.trim().toLowerCase() || null;
  const fallbackOwnerLogin = options.fallbackOwnerLogin?.trim().toLowerCase() || null;
  const sorted = sortGitHubCodespaces(codespaces, preferredRepositoryName);

  const matches = sorted.filter(
    (codespace) => codespace.repositoryName?.trim().toLowerCase() === preferredRepositoryName
  );
  if (matches.length === 0) {
    return null;
  }

  if (preferredOwnerLogin) {
    const preferredOwnerMatch =
      matches.find((codespace) => codespace.ownerLogin?.trim().toLowerCase() === preferredOwnerLogin) ??
      null;
    if (preferredOwnerMatch) {
      return preferredOwnerMatch;
    }
  }

  if (fallbackOwnerLogin) {
    const fallbackOwnerMatch =
      matches.find((codespace) => codespace.ownerLogin?.trim().toLowerCase() === fallbackOwnerLogin) ??
      null;
    if (fallbackOwnerMatch) {
      return fallbackOwnerMatch;
    }
  }

  return matches[0] ?? null;
}

async function githubApiRequest(
  pathname: string,
  accessToken: string,
  options: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: GITHUB_API_ACCEPT,
    Authorization: `Bearer ${accessToken.trim()}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  let body: string | undefined;
  if (typeof options.body !== 'undefined') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${GITHUB_API_BASE_URL}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubApiError(
      readGitHubErrorMessage(payload) ?? `GitHub request failed (${response.status})`,
      response.status
    );
  }

  return payload;
}

function resolveGitHubTunnelApiBaseUrl(
  clusterId: string | null,
  serviceUri: string | null
): string {
  if (clusterId) {
    return `https://${clusterId}.rel.tunnels.api.visualstudio.com`;
  }
  if (serviceUri) {
    return serviceUri.replace(/\/+$/g, '');
  }
  throw new Error('GitHub did not return Codespaces tunnel details.');
}

async function publishGitHubCodespacePort(
  baseUrl: string,
  tunnelId: string,
  managePortsAccessToken: string,
  port: number
): Promise<void> {
  const pathname = `/tunnels/${encodeURIComponent(tunnelId)}/ports/${String(port)}?includePorts=true&api-version=2023-09-27-preview`;
  try {
    await githubTunnelApiRequest(`${baseUrl}${pathname}`, managePortsAccessToken, {
      method: 'DELETE',
    });
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }
  }

  await githubTunnelApiRequest(`${baseUrl}${pathname}`, managePortsAccessToken, {
    method: 'PUT',
    body: {
      portNumber: port,
      labels: ['UserForwardedPort'],
      protocol: 'http',
      accessControl: {
        entries: [
          {
            type: 'Anonymous',
            subjects: [],
            scopes: ['connect'],
          },
        ],
      },
      options: {
        isGloballyAvailable: true,
      },
      portForwardingUris: null,
      inspectionUri: '',
    },
  });
}

async function waitForGitHubCodespacePortsPublic(
  baseUrl: string,
  tunnelId: string,
  managePortsAccessToken: string,
  ports: number[]
): Promise<void> {
  const pendingPorts = new Set(ports);
  const lastStatusByPort = new Map<number, string>();
  const startedAt = Date.now();

  while (pendingPorts.size > 0 && Date.now() - startedAt <= GITHUB_CODESPACES_PORT_PUBLIC_TIMEOUT_MS) {
    await Promise.all(
      [...pendingPorts].map(async (port) => {
        const payload = await fetchGitHubCodespacePort(
          baseUrl,
          tunnelId,
          managePortsAccessToken,
          port
        );
        if (isGitHubCodespaceTunnelPortPublic(payload)) {
          pendingPorts.delete(port);
          lastStatusByPort.delete(port);
          return;
        }
        lastStatusByPort.set(port, describeGitHubCodespaceTunnelPortVisibility(payload));
      })
    );

    if (pendingPorts.size === 0) {
      return;
    }

    await sleep(GITHUB_CODESPACES_PORT_PUBLIC_POLL_MS);
  }

  const details = [...pendingPorts]
    .map((port) => `${String(port)} ${lastStatusByPort.get(port) ?? 'was not public'}`)
    .join(', ');
  throw new Error(`GitHub did not make Codespaces port(s) public: ${details}.`);
}

async function fetchGitHubCodespacePort(
  baseUrl: string,
  tunnelId: string,
  managePortsAccessToken: string,
  port: number
): Promise<unknown> {
  const pathname = `/tunnels/${encodeURIComponent(tunnelId)}/ports/${String(port)}?includePorts=true&api-version=2023-09-27-preview`;
  return await githubTunnelApiRequest(`${baseUrl}${pathname}`, managePortsAccessToken);
}

function isGitHubCodespaceTunnelPortPublic(payload: unknown): boolean {
  const record = asRecord(payload);
  const accessControl = asRecord(record?.accessControl);
  const entries = Array.isArray(accessControl?.entries) ? accessControl.entries : [];
  return entries.some((entry) => {
    const entryRecord = asRecord(entry);
    if (!entryRecord || entryRecord.type !== 'Anonymous') {
      return false;
    }
    const scopes = Array.isArray(entryRecord.scopes) ? entryRecord.scopes : [];
    return scopes.includes('connect');
  });
}

function describeGitHubCodespaceTunnelPortVisibility(payload: unknown): string {
  const record = asRecord(payload);
  const accessControl = asRecord(record?.accessControl);
  const entries = Array.isArray(accessControl?.entries) ? accessControl.entries : [];
  if (entries.length === 0) {
    return 'has no tunnel access-control entries';
  }
  const entryTypes = entries
    .map((entry) => asRecord(entry)?.type)
    .filter((entryType): entryType is string => typeof entryType === 'string' && entryType.length > 0);
  return entryTypes.length > 0
    ? `is still restricted to ${entryTypes.join('/')}`
    : 'is still restricted';
}

async function githubTunnelApiRequest(
  url: string,
  managePortsAccessToken: string,
  options: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Tunnel ${managePortsAccessToken}`,
  };
  let body: string | undefined;
  if (typeof options.body !== 'undefined') {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubApiError(
      readGitHubErrorMessage(payload) ?? `GitHub Codespaces tunnel request failed (${response.status})`,
      response.status
    );
  }

  return payload;
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

function normalizeGitHubCodespace(value: unknown): GitHubCodespace | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const repository = asRecord(record.repository);
  const owner = asRecord(repository?.owner);

  return {
    name: readRequiredString(record, 'name'),
    state: readOptionalString(record, 'state') ?? 'Unknown',
    webUrl: readOptionalString(record, 'web_url'),
    lastUsedAt: readOptionalString(record, 'last_used_at'),
    updatedAt: readOptionalString(record, 'updated_at'),
    repositoryFullName: readOptionalString(repository, 'full_name'),
    repositoryName: readOptionalString(repository, 'name'),
    ownerLogin: readOptionalString(owner, 'login'),
  };
}

function normalizeGitHubCodespaceIdleTimeoutMinutes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(5, Math.min(240, Math.round(value)));
}

function normalizeGitHubRepository(value: unknown): GitHubRepository | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readOptionalNumber(record, 'id');
  const owner = asRecord(record.owner);
  const ownerLogin = readOptionalString(owner, 'login');
  const repoName = readOptionalString(record, 'name');
  const fullName = readOptionalString(record, 'full_name');
  if (id === null || !ownerLogin || !repoName || !fullName) {
    return null;
  }

  return {
    id,
    owner: ownerLogin,
    name: repoName,
    fullName,
    defaultBranch: readOptionalString(record, 'default_branch'),
    isFork: Boolean(record.fork),
  };
}

function normalizeGitHubAppInstallation(value: unknown): GitHubAppInstallation | null {
  const record = asRecord(value);
  const id = readOptionalNumber(record, 'id');
  if (!record || id === null) {
    return null;
  }

  const account = asRecord(record.account);
  const repositorySelection = readOptionalString(record, 'repository_selection');
  return {
    id,
    accountLogin: readOptionalString(account, 'login'),
    accountId: readOptionalNumber(account, 'id'),
    targetType: readOptionalString(record, 'target_type'),
    repositorySelection:
      repositorySelection === 'all' || repositorySelection === 'selected'
        ? repositorySelection
        : null,
    htmlUrl: readOptionalString(record, 'html_url'),
  };
}

function normalizeGitHubAppInstallationRepository(
  value: unknown,
  installationId: number
): GitHubAppInstallationRepository | null {
  const record = asRecord(value);
  const id = readOptionalNumber(record, 'id');
  const fullName = readOptionalString(record, 'full_name');
  const name = readOptionalString(record, 'name');
  const ownerRecord = asRecord(record?.owner);
  const owner = readOptionalString(ownerRecord, 'login');
  if (!record || id === null || !fullName || !name || !owner) {
    return null;
  }

  const repositoryPermissions = normalizeGitHubAppRepositoryPermissions(record.permissions);

  return {
    id,
    installationId,
    owner,
    name,
    fullName,
    private: Boolean(record.private),
    permissions: repositoryPermissions.permissions,
    canReadContents: repositoryPermissions.canReadContents,
    canWriteContents: repositoryPermissions.canWriteContents,
  };
}

function normalizeGitHubAppRepositoryPermissions(value: unknown): {
  permissions: string[];
  canReadContents: boolean;
  canWriteContents: boolean;
} {
  const record = asRecord(value);
  if (!record) {
    return {
      permissions: [],
      canReadContents: false,
      canWriteContents: false,
    };
  }

  const permissions = new Set<string>();
  let canReadContents = false;
  let canWriteContents = false;

  Object.entries(record).forEach(([rawPermission, rawLevel]) => {
    const permission = rawPermission.trim().toLowerCase();
    if (!permission) {
      return;
    }

    const level =
      typeof rawLevel === 'string'
        ? rawLevel.trim().toLowerCase()
        : rawLevel === true
          ? 'true'
          : rawLevel === false
            ? 'false'
            : '';
    if (!level || level === 'false') {
      return;
    }

    permissions.add(permission);

    if (permission === 'contents') {
      if (level === 'read' || level === 'write' || level === 'admin') {
        canReadContents = true;
      }
      if (level === 'write' || level === 'admin') {
        canWriteContents = true;
      }
      return;
    }

    if (level === 'true') {
      if (permission === 'pull' || permission === 'push' || permission === 'maintain' || permission === 'admin') {
        canReadContents = true;
      }
      if (permission === 'push' || permission === 'maintain' || permission === 'admin') {
        canWriteContents = true;
      }
    }
  });

  return {
    permissions: [...permissions].sort(),
    canReadContents,
    canWriteContents,
  };
}

function normalizePortForwardingDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
  const withoutPath = withoutScheme.split('/')[0]?.trim() ?? '';
  const normalized = withoutPath.replace(/^\.+|\.+$/g, '');
  return normalized || null;
}

function isPreferredCodespace(
  codespace: GitHubCodespace,
  preferredRepositoryName: string | null
): boolean {
  if (!preferredRepositoryName) {
    return false;
  }

  return codespace.repositoryName?.trim().toLowerCase() === preferredRepositoryName;
}

function readGitHubErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const description =
    readOptionalString(record, 'error_description') ??
    readOptionalString(record, 'message');
  return description ?? null;
}

function readGitHubUserAccessToken(record: Record<string, unknown> | null): GitHubUserAccessToken {
  const issuedAtMs = Date.now();
  const accessToken = readRequiredString(record, 'access_token');
  const tokenType = readOptionalString(record, 'token_type') ?? 'bearer';
  const scope = (readOptionalString(record, 'scope') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const expiresInSec = readOptionalNumber(record, 'expires_in');
  const refreshToken = readOptionalString(record, 'refresh_token');
  const refreshTokenExpiresInSec = readOptionalNumber(record, 'refresh_token_expires_in');

  return {
    accessToken,
    scope,
    tokenType,
    refreshToken,
    expiresInSec,
    accessTokenExpiresAtMs:
      expiresInSec !== null ? issuedAtMs + expiresInSec * 1000 : null,
    refreshTokenExpiresInSec,
    refreshTokenExpiresAtMs:
      refreshTokenExpiresInSec !== null ? issuedAtMs + refreshTokenExpiresInSec * 1000 : null,
  };
}

function readRequiredString(record: Record<string, unknown> | null, key: string): string {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new Error(`Missing GitHub field: ${key}`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown> | null, key: string): number {
  const value = readOptionalNumber(record, key);
  if (value === null) {
    throw new Error(`Missing GitHub field: ${key}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record || typeof record[key] !== 'string') {
    return null;
  }

  const trimmed = record[key].trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalNumber(record: Record<string, unknown> | null, key: string): number | null {
  if (!record || typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    return null;
  }

  return record[key];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
