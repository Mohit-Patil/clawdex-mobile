import {
  buildGitHubAppAuthorizeUrl,
  buildGitHubAppRedirectUri,
  buildGitHubAppWebCallbackUrl,
  validateGitHubAppCallbackUrl,
} from '../githubAppAuth';

describe('githubAppAuth helpers', () => {
  it('builds the GitHub App web callback URL from the auth backend origin', () => {
    expect(buildGitHubAppWebCallbackUrl('https://getclawdex.com')).toBe(
      'https://getclawdex.com/github/callback'
    );
  });

  it('builds the GitHub App web authorize URL', () => {
    expect(
      buildGitHubAppAuthorizeUrl({
        clientId: 'Iv23liaTdPNfi73uBFKi',
        authBaseUrl: 'https://getclawdex.com',
        state: 'state-123',
      })
    ).toBe(
      'https://github.com/login/oauth/authorize?client_id=Iv23liaTdPNfi73uBFKi&redirect_uri=https%3A%2F%2Fgetclawdex.com%2Fgithub%2Fcallback&state=state-123&prompt=select_account'
    );
  });

  it('builds the shared GitHub App redirect URI', () => {
    expect(buildGitHubAppRedirectUri()).toBe('clawdex://github/callback');
  });

  it('accepts shared app-scheme callback URLs', () => {
    const callback = validateGitHubAppCallbackUrl(
      new URL('clawdex://github/callback?code=abc&state=state-123')
    );
    expect(callback.searchParams.get('code')).toBe('abc');
    expect(callback.searchParams.get('state')).toBe('state-123');
  });

  it('rejects invalid callback destinations', () => {
    expect(() =>
      validateGitHubAppCallbackUrl(new URL('https://example.com/github/callback?code=abc'))
    ).toThrow('invalid callback URL');
  });
});
