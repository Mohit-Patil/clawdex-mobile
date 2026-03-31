import { createAppTheme, resolveThemeMode } from '../theme';

describe('theme', () => {
  it('resolves system preference from the device scheme', () => {
    expect(resolveThemeMode('system', 'light')).toBe('light');
    expect(resolveThemeMode('system', 'dark')).toBe('dark');
  });

  it('honors explicit appearance preferences', () => {
    expect(resolveThemeMode('light', 'dark')).toBe('light');
    expect(resolveThemeMode('dark', 'light')).toBe('dark');
  });

  it('builds light-mode runtime properties', () => {
    const theme = createAppTheme('light');

    expect(theme.mode).toBe('light');
    expect(theme.isDark).toBe(false);
    expect(theme.keyboardAppearance).toBe('light');
    expect(theme.blurTint).toBe('light');
    expect(theme.statusBarStyle).toBe('dark-content');
    expect(theme.colors.bgMain).toBe('#DDE7F0');
    expect(theme.colors.accentText).toBe('#FFFFFF');
  });

  it('builds dark-mode runtime properties', () => {
    const theme = createAppTheme('dark');

    expect(theme.mode).toBe('dark');
    expect(theme.isDark).toBe(true);
    expect(theme.keyboardAppearance).toBe('dark');
    expect(theme.blurTint).toBe('dark');
    expect(theme.statusBarStyle).toBe('light-content');
    expect(theme.colors.bgMain).toBe('#000000');
    expect(theme.colors.accentText).toBe('#000000');
  });
});
