import {
  buildGitHubAppInstallUrl,
  buildGitHubCodespacesRepositoryCandidates,
  buildGitHubCodespacesBridgeUrl,
  createGitHubCodespaceForAuthenticatedUser,
  deleteGitHubCodespace,
  fetchGitHubCodespace,
  fetchGitHubCodespaces,
  fetchGitHubAppAccessSnapshot,
  findReusableGitHubCodespace,
  GitHubApiError,
  getReusableGitHubBridgeProfile,
  hasGitHubAppRepositoryAccess,
  isRetryableGitHubDeviceFlowError,
  publishGitHubCodespacePorts,
  sortGitHubCodespaces,
  shouldRefreshGitHubUserAccessToken,
  startGitHubCodespace,
  stopGitHubCodespace,
} from '../githubCodespaces';

describe('githubCodespaces helpers', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      Reflect.deleteProperty(globalThis, 'fetch');
    }
    jest.restoreAllMocks();
  });

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
              canReadContents: true,
              canWriteContents: true,
            },
          ],
        },
        'octocat/clawdex-mobile'
      )
    ).toBe(true);
    expect(hasGitHubAppRepositoryAccess({ repositories: [] }, 'octocat/other')).toBe(false);
  });

  it('loads all paged GitHub App repositories with read and write access', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({
          installations: [
            {
              id: 10,
              account: { login: 'octocat', id: 1 },
              repository_selection: 'all',
            },
          ],
        })),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({
          repositories: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            owner: { login: 'octocat' },
            name: `repo-${String(index + 1)}`,
            full_name: `octocat/repo-${String(index + 1)}`,
            private: index % 2 === 0,
            permissions: { contents: 'write', metadata: 'read' },
          })),
        })),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({
          repositories: [
            {
              id: 101,
              owner: { login: 'octocat' },
              name: 'repo-101',
              full_name: 'octocat/repo-101',
              private: false,
              permissions: { contents: 'read', metadata: 'read' },
            },
            {
              id: 102,
              owner: { login: 'octocat' },
              name: 'repo-102',
              full_name: 'octocat/repo-102',
              private: false,
              permissions: { push: true, pull: true },
            },
          ],
        })),
      } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await fetchGitHubAppAccessSnapshot('ghu_token');

    expect(snapshot.repositories).toHaveLength(101);
    expect(snapshot.repositories.some((repository) => repository.fullName === 'octocat/repo-101')).toBe(
      false
    );
    expect(snapshot.repositories.at(-1)?.fullName).toBe('octocat/repo-102');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/user/installations/10/repositories?per_page=100&page=2',
      expect.any(Object)
    );
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

  it('deletes a Codespace through the GitHub API', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(''),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deleteGitHubCodespace('ghu_token', 'octocat space');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/codespaces/octocat%20space',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ghu_token',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      })
    );
  });

  it('pauses a Codespace through the GitHub API', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(''),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await stopGitHubCodespace('ghu_token', 'octocat space');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/codespaces/octocat%20space/stop',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ghu_token',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      })
    );
  });

  it('creates Codespaces with a moderate idle timeout by default', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        name: 'octocat-space',
        state: 'Available',
        web_url: 'https://github.com/codespaces/octocat-space',
        repository: {
          name: 'clawdex-mobile',
          full_name: 'octocat/clawdex-mobile',
          owner: { login: 'octocat' },
        },
      })),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createGitHubCodespaceForAuthenticatedUser('ghu_token', 123, { ref: 'main' });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/codespaces',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      repository_id: 123,
      ref: 'main',
      idle_timeout_minutes: 45,
    });
  });

  it('loads all paged Codespaces from GitHub', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `space-${String(index + 1)}`,
      state: 'Available',
      repository: {
        name: 'clawdex-mobile',
        full_name: 'octocat/clawdex-mobile',
        owner: { login: 'octocat' },
      },
    }));
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ codespaces: firstPage })),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({
          codespaces: [
            {
              name: 'space-101',
              state: 'Shutdown',
              repository: {
                name: 'website',
                full_name: 'octocat/website',
                owner: { login: 'octocat' },
              },
            },
          ],
        })),
      } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const codespaces = await fetchGitHubCodespaces('ghu_token');

    expect(codespaces).toHaveLength(101);
    expect(codespaces.at(-1)).toMatchObject({
      name: 'space-101',
      repositoryFullName: 'octocat/website',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/codespaces?per_page=100&page=2',
      expect.any(Object)
    );
  });

  it('fetches a Codespace by name through the GitHub API', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        name: 'octocat-space',
        state: 'Shutdown',
        web_url: 'https://github.com/codespaces/octocat-space',
        repository: {
          name: 'clawdex-mobile',
          full_name: 'octocat/clawdex-mobile',
          owner: { login: 'octocat' },
        },
      })),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const codespace = await fetchGitHubCodespace('ghu_token', 'octocat space');

    expect(codespace).toMatchObject({
      name: 'octocat-space',
      state: 'Shutdown',
      repositoryFullName: 'octocat/clawdex-mobile',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/codespaces/octocat%20space',
      expect.objectContaining({
        method: 'GET',
      })
    );
  });

  it('starts a Codespace through the GitHub API', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(''),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await startGitHubCodespace('ghu_token', 'octocat space');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/codespaces/octocat%20space/start',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });

  it('publishes the bridge ports through the Codespaces tunnel API', async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === 'https://api.github.com/user/codespaces/octocat%20space?internal=true&refresh=true') {
        return Promise.resolve({
          ok: true,
          text: jest.fn().mockResolvedValue(JSON.stringify({
            name: 'octocat-space',
            connection: {
              tunnelProperties: {
                tunnelId: 'tunnel-id',
                clusterId: 'use',
                managePortsAccessToken: 'tunnel-token',
              },
            },
          })),
        } as unknown as Response);
      }

      if (init?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          text: jest.fn().mockResolvedValue(JSON.stringify({
            accessControl: {
              entries: [
                {
                  type: 'Anonymous',
                  subjects: [],
                  scopes: ['connect'],
                },
              ],
            },
          })),
        } as unknown as Response);
      }

      return Promise.resolve({
        ok: true,
        text: jest.fn().mockResolvedValue(''),
      } as unknown as Response);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await publishGitHubCodespacePorts('ghu_token', 'octocat space', [8787, 8788, 8787]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user/codespaces/octocat%20space?internal=true&refresh=true',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghu_token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://use.rel.tunnels.api.visualstudio.com/tunnels/tunnel-id/ports/8787?includePorts=true&api-version=2023-09-27-preview',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Tunnel tunnel-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://use.rel.tunnels.api.visualstudio.com/tunnels/tunnel-id/ports/8787?includePorts=true&api-version=2023-09-27-preview',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          portNumber: 8787,
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
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'https://use.rel.tunnels.api.visualstudio.com/tunnels/tunnel-id/ports/8787?includePorts=true&api-version=2023-09-27-preview',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Tunnel tunnel-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      'https://use.rel.tunnels.api.visualstudio.com/tunnels/tunnel-id/ports/8788?includePorts=true&api-version=2023-09-27-preview',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Tunnel tunnel-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('includes the GitHub API status on failed Codespace lookups', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: jest.fn().mockResolvedValue(JSON.stringify({ message: 'Not Found' })),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchGitHubCodespace('ghu_token', 'missing-space')).rejects.toBeInstanceOf(
      GitHubApiError
    );
    await expect(fetchGitHubCodespace('ghu_token', 'missing-space')).rejects.toMatchObject({
      name: 'GitHubApiError',
      message: 'Not Found',
      status: 404,
    });
  });
});
