import {
  buildChatGptRedirectUri,
  buildAuthorizeUrl,
  decodeJwtClaims,
  isNativeChatGptLoginAvailable,
  validateCallbackUrl,
} from '../chatGptAuth';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    appOwnership: null,
  },
}));

jest.mock('react-native-tcp-socket', () => ({
  __esModule: true,
  default: {
    createServer: jest.fn(),
  },
}));

describe('chatGptAuth helpers', () => {
  it('builds the localhost redirect URI used with OpenAI auth', () => {
    expect(buildChatGptRedirectUri()).toBe('http://localhost:1455/auth/callback');
  });

  it('builds the expected authorize URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        state: 'state-123',
        codeChallenge: 'challenge-123',
        redirectUri: 'http://localhost:1455/auth/callback',
      })
    );

    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-123');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('accepts shared app-scheme callback URLs', () => {
    const callback = validateCallbackUrl(new URL('clawdex://auth/callback?code=abc'));
    expect(callback.searchParams.get('code')).toBe('abc');
  });

  it('still accepts legacy localhost callback URLs', () => {
    const callback = validateCallbackUrl(new URL('http://localhost:1455/auth/callback?code=abc'));
    expect(callback.searchParams.get('code')).toBe('abc');
  });

  it('rejects invalid callback destinations', () => {
    expect(() =>
      validateCallbackUrl(new URL('http://example.com:1455/auth/callback?code=abc'))
    ).toThrow('invalid callback URL');
  });

  it('decodes auth claims nested under the OpenAI claim namespace', () => {
    const payload = {
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-123',
        chatgpt_plan_type: 'plus',
      },
    };
    const jwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

    expect(decodeJwtClaims(jwt)).toEqual({
      chatgpt_account_id: 'acct-123',
      chatgpt_plan_type: 'plus',
    });
  });

  it('reports native ChatGPT login as unavailable in Expo Go', () => {
    const constants = jest.requireMock('expo-constants').default as { appOwnership: string | null };
    constants.appOwnership = 'expo';
    expect(isNativeChatGptLoginAvailable()).toBe(false);
    constants.appOwnership = null;
  });
});
