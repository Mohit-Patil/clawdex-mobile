import { DEFAULT_WORKSPACE_CHAT_LIMIT, parseAppSettings } from '../appSettings';
import { DEFAULT_FONT_PREFERENCE } from '../fonts';

describe('parseAppSettings', () => {
  it('defaults fresh installs to system appearance', () => {
    expect(parseAppSettings('')).toMatchObject({
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      defaultChatEngine: 'codex',
      approvalMode: 'yolo',
      showToolCalls: true,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
    });
  });

  it('defaults showToolCalls to true when unset in stored settings', () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 6,
          appearancePreference: 'system',
        })
      ).showToolCalls
    ).toBe(true);
  });

  it('preserves an explicit false showToolCalls preference', () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 6,
          showToolCalls: false,
        })
      ).showToolCalls
    ).toBe(false);
  });

  it('migrates version 4 installs to dark appearance when unset', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 4,
        bridgeUrl: 'http://192.168.1.10:9000',
        bridgeToken: 'secret',
        defaultStartCwd: '/tmp/workspace',
        defaultChatEngine: 'codex',
        defaultEngineSettings: {
          codex: { modelId: 'gpt-5.4', effort: 'high' },
          opencode: { modelId: null, effort: null },
        },
        approvalMode: 'normal',
        showToolCalls: true,
      })
    );

    expect(parsed.appearancePreference).toBe('dark');
    expect(parsed.darkUiPalette).toBe('classic');
    expect(parsed.defaultEngineSettings.codex).toEqual({
      modelId: 'gpt-5.4',
      effort: 'high',
    });
  });

  it('preserves stored appearance preferences for version 5 settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 5,
        appearancePreference: 'light',
      })
    );

    expect(parsed.appearancePreference).toBe('light');
  });

  it('accepts version 6 settings without bridge credentials', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 6,
        defaultChatEngine: 'opencode',
        appearancePreference: 'system',
      })
    );

    expect(parsed.bridgeUrl).toBeNull();
    expect(parsed.bridgeToken).toBeNull();
    expect(parsed.defaultChatEngine).toBe('opencode');
    expect(parsed.appearancePreference).toBe('system');
  });

  it('preserves a stored font preference for version 8 settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 8,
        fontPreference: 'spaceGrotesk',
      })
    );

    expect(parsed.fontPreference).toBe('spaceGrotesk');
  });

  it('preserves darkUiPalette for version 10 settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 10,
        darkUiPalette: 'grey',
      })
    );

    expect(parsed.darkUiPalette).toBe('grey');
  });

  it('normalizes the workspace chat limit for version 9 settings', () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 9,
          workspaceChatLimit: 10,
        })
      ).workspaceChatLimit
    ).toBe(10);
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 9,
          workspaceChatLimit: 'all',
        })
      ).workspaceChatLimit
    ).toBeNull();
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 9,
          workspaceChatLimit: 3,
        })
      ).workspaceChatLimit
    ).toBe(DEFAULT_WORKSPACE_CHAT_LIMIT);
  });
});
