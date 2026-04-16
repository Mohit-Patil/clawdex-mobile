import {
  buildGitHubAppInstallUrl,
  buildGitHubCodespacesRepositoryCandidates,
  buildGitHubCodespacesBridgeUrl,
  findReusableGitHubCodespace,
  getReusableGitHubBridgeProfile,
  hasGitHubAppRepositoryAccess,
  isRetryableGitHubDeviceFlowError,
  sortGitHubCodespaces,
  shouldRefreshGitHubUserAccessToken,
} from '../githubCodespaces';

describe('githubCodespaces helpers', () => {
  it('builds the forwarded Codespaces bridge URL', () => {
    expect(
      buildGitHubCodespacesBridgeUrl('octocat-codespace', 'app.github.dev')
    ).toBe('https://octocat-codespace-8787.app.github.dev');
  });

  it('builds the GitHub App install URL from the app slug', () => {
    expect(buildGitHubAppInstallUrl('clawdex-mobile', 'octocat')).toBe(
      'https://github.com/apps/clawdex-mobile/installations/new?state=octocat'
    );
  });

  it('reuses the active GitHub-auth bridge profile first', () => {
    const result = getReusableGitHubBridgeProfile(
      [
        {
          id: 'manual-1',
          name: 'Office bridge',
          bridgeUrl: 'http://192.168.1.20:8787',
          bridgeToken: 'secret',
          authMode: 'bridgeToken',
          githubUserLogin: null,
          githubCodespaceName: null,
          githubRepositoryFullName: null,
          githubRefreshToken: null,
          githubAccessTokenExpiresAt: null,
          githubRefreshTokenExpiresAt: null,
          createdAt: '2026-04-14T00:00:00.000Z',
          updatedAt: '2026-04-14T00:00:00.000Z',
        },
        {
          id: 'github-1',
          name: 'clawdex-mobile · octocat-codespace',
          bridgeUrl: 'https://octocat-codespace-8787.app.github.dev',
          bridgeToken: 'ghu_token',
          authMode: 'githubApp',
          githubUserLogin: 'octocat',
          githubCodespaceName: 'octocat-codespace',
          githubRepositoryFullName: 'octocat/clawdex-mobile',
          githubRefreshToken: 'ghr_refresh',
          githubAccessTokenExpiresAt: '2026-04-16T12:00:00.000Z',
          githubRefreshTokenExpiresAt: '2026-10-16T12:00:00.000Z',
          createdAt: '2026-04-14T00:00:00.000Z',
          updatedAt: '2026-04-14T00:00:00.000Z',
        },
      ],
      'github-1'
    );

    expect(result?.id).toBe('github-1');
  });

  it('sorts preferred repository Codespaces to the top', () => {
    const sorted = sortGitHubCodespaces(
      [
        {
          name: 'misc-space',
          state: 'Available',
          webUrl: null,
          lastUsedAt: '2026-04-14T10:00:00.000Z',
          updatedAt: '2026-04-14T10:00:00.000Z',
          repositoryFullName: 'octocat/misc',
          repositoryName: 'misc',
          ownerLogin: 'octocat',
        },
        {
          name: 'clawdex-space',
          state: 'Shutdown',
          webUrl: null,
          lastUsedAt: '2026-04-14T09:00:00.000Z',
          updatedAt: '2026-04-14T09:00:00.000Z',
          repositoryFullName: 'octocat/clawdex-mobile',
          repositoryName: 'clawdex-mobile',
          ownerLogin: 'octocat',
        },
      ],
      'clawdex-mobile'
    );

    expect(sorted[0]?.name).toBe('clawdex-space');
  });

  it('prefers the signed-in user repository before the configured source owner', () => {
    const candidates = buildGitHubCodespacesRepositoryCandidates(
      'octocat',
      'clawdex-mobile',
      'Mohit-Patil'
    );

    expect(candidates.map((candidate) => candidate.fullName)).toEqual([
      'octocat/clawdex-mobile',
      'Mohit-Patil/clawdex-mobile',
    ]);
  });

  it('reuses an existing preferred-repo Codespace before creating another one', () => {
    const codespace = findReusableGitHubCodespace(
      [
        {
          name: 'other-space',
          state: 'Available',
          webUrl: null,
          lastUsedAt: '2026-04-14T10:00:00.000Z',
          updatedAt: '2026-04-14T10:00:00.000Z',
          repositoryFullName: 'octocat/misc',
          repositoryName: 'misc',
          ownerLogin: 'octocat',
        },
        {
          name: 'user-owned-space',
          state: 'Shutdown',
          webUrl: null,
          lastUsedAt: '2026-04-14T09:00:00.000Z',
          updatedAt: '2026-04-14T09:00:00.000Z',
          repositoryFullName: 'octocat/clawdex-mobile',
          repositoryName: 'clawdex-mobile',
          ownerLogin: 'octocat',
        },
        {
          name: 'fallback-space',
          state: 'Available',
          webUrl: null,
          lastUsedAt: '2026-04-14T08:00:00.000Z',
          updatedAt: '2026-04-14T08:00:00.000Z',
          repositoryFullName: 'Mohit-Patil/clawdex-mobile',
          repositoryName: 'clawdex-mobile',
          ownerLogin: 'Mohit-Patil',
        },
      ],
      {
        preferredRepositoryName: 'clawdex-mobile',
        preferredOwnerLogin: 'octocat',
        fallbackOwnerLogin: 'Mohit-Patil',
      }
    );

    expect(codespace?.name).toBe('user-owned-space');
  });

  it('detects when the GitHub App already has repository access', () => {
    expect(
      hasGitHubAppRepositoryAccess(
        {
          repositories: [
            {
              id: 1,
              installationId: 10,
              owner: 'octocat',
              name: 'clawdex-mobile',
              fullName: 'octocat/clawdex-mobile',
              private: true,
              permissions: ['contents', 'codespaces'],
            },
          ],
        },
        'octocat/clawdex-mobile'
      )
    ).toBe(true);
    expect(hasGitHubAppRepositoryAccess({ repositories: [] }, 'octocat/other')).toBe(false);
  });

  it('refreshes expiring GitHub App tokens when a refresh token exists', () => {
    const now = Date.UTC(2026, 3, 16, 12, 0, 0);
    expect(
      shouldRefreshGitHubUserAccessToken(
        {
          accessTokenExpiresAtMs: now + 30_000,
          refreshToken: 'ghr_refresh',
          refreshTokenExpiresAtMs: now + 60_000,
        },
        now
      )
    ).toBe(true);
    expect(
      shouldRefreshGitHubUserAccessToken(
        {
          accessTokenExpiresAtMs: now + 10 * 60_000,
          refreshToken: 'ghr_refresh',
          refreshTokenExpiresAtMs: now + 60_000,
        },
        now
      )
    ).toBe(false);
  });

  it('treats transient device-flow network failures as retryable', () => {
    expect(isRetryableGitHubDeviceFlowError(new Error('Network request failed'))).toBe(true);
    expect(
      isRetryableGitHubDeviceFlowError(
        new Error('The Internet connection appears to be offline.')
      )
    ).toBe(true);
    expect(isRetryableGitHubDeviceFlowError(new Error('GitHub token exchange failed (401)'))).toBe(
      false
    );
  });
});
