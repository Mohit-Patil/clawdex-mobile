import {
  computerUseActionIconName,
  isComputerUseTraceEntry,
  parseComputerUseTraceEntry,
} from '../computerUseTrace';

describe('computerUseTrace', () => {
  it('detects computer-use entries across naming variants', () => {
    expect(
      isComputerUseTraceEntry({
        title: 'Called tool `computer-use / click`',
      })
    ).toBe(true);
    expect(
      isComputerUseTraceEntry({
        title: 'Called tool `computer_use / get_app_state`',
      })
    ).toBe(true);
    expect(
      isComputerUseTraceEntry({
        title: 'Called tool `filesystem / read_file`',
      })
    ).toBe(false);
  });

  it('parses action, app, and window metadata from computer-use traces', () => {
    const parsed = parseComputerUseTraceEntry({
      title: 'Called tool `computer-use / type_text`',
      details: [
        'App=com.google.Chrome (pid 28859)',
        'Window: ".git-debug.txt - clawdex-codespace", App: Google Chrome.',
        '0 standard window Secondary Actions:',
        'Raise, .git-debug.txt - clawdex-codespace',
      ],
    });

    expect(parsed).toEqual({
      actionKey: 'typetext',
      actionLabel: 'Typed text',
      appName: 'Google Chrome',
      windowTitle: '.git-debug.txt - clawdex-codespace',
    });
  });

  it('maps action keys to stable icons', () => {
    expect(computerUseActionIconName('getappstate')).toBe('scan-outline');
    expect(computerUseActionIconName('scroll')).toBe('swap-vertical-outline');
    expect(computerUseActionIconName('unknownaction')).toBe('desktop-outline');
  });
});
