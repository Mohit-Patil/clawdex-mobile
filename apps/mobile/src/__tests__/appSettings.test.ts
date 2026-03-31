import { parseAppSettings } from '../appSettings';

describe('parseAppSettings', () => {
  it('defaults fresh installs to system appearance', () => {
    expect(parseAppSettings('')).toMatchObject({
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      defaultChatEngine: 'codex',
      approvalMode: 'yolo',
      showToolCalls: false,
      appearancePreference: 'system',
    });
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
});
