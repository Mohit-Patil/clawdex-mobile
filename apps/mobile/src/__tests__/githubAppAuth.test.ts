import {
  buildGitHubAppRedirectUri,
  validateGitHubAppCallbackUrl,
} from '../githubAppAuth';

describe('githubAppAuth helpers', () => {
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
