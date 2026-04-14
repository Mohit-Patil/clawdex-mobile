import {
  buildGitHubCodespacesRepositoryCandidates,
  buildGitHubCodespacesBridgeUrl,
  findReusableGitHubCodespace,
  getReusableGitHubBridgeProfile,
  isRetryableGitHubDeviceFlowError,
  sortGitHubCodespaces,
} from '../githubCodespaces';

describe('githubCodespaces helpers', () => {
  it('builds the forwarded Codespaces bridge URL', () => {
    expect(
      buildGitHubCodespacesBridgeUrl('octocat-codespace', 'app.github.dev')
    ).toBe('https://octocat-codespace-8787.app.github.dev');
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
          createdAt: '2026-04-14T00:00:00.000Z',
          updatedAt: '2026-04-14T00:00:00.000Z',
        },
        {
          id: 'github-1',
          name: 'clawdex-mobile · octocat-codespace',
          bridgeUrl: 'https://octocat-codespace-8787.app.github.dev',
          bridgeToken: 'gho_token',
          authMode: 'githubOAuth',
          githubUserLogin: 'octocat',
          githubCodespaceName: 'octocat-codespace',
          githubRepositoryFullName: 'octocat/clawdex-mobile',
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
