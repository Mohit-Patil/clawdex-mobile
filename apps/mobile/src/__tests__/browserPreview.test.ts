import {
  applyBrowserPreviewViewportPreset,
  buildBrowserPreviewViewportNavigationUrl,
  buildBrowserPreviewBootstrapUrl,
  dedupeRecentPreviewTargets,
  extractLocalPreviewUrls,
  normalizePreviewTargetInput,
  pushRecentPreviewTarget,
} from '../browserPreview';

describe('browserPreview', () => {
  it('normalizes bare ports into loopback preview URLs', () => {
    expect(normalizePreviewTargetInput('3000')).toBe('http://127.0.0.1:3000/');
  });

  it('normalizes localhost inputs without a scheme', () => {
    expect(normalizePreviewTargetInput('localhost:5173')).toBe('http://localhost:5173/');
  });

  it('rejects non-loopback preview targets', () => {
    expect(normalizePreviewTargetInput('https://example.com')).toBeNull();
  });

  it('extracts local preview URLs from mixed text', () => {
    expect(
      extractLocalPreviewUrls(
        'Server ready on http://localhost:3000 and HMR on http://127.0.0.1:5173/__vite_ping'
      )
    ).toEqual([
      'http://localhost:3000/',
      'http://127.0.0.1:5173/__vite_ping',
    ]);
  });

  it('keeps recent preview targets unique and ordered', () => {
    expect(
      pushRecentPreviewTarget(
        ['http://127.0.0.1:3000/', 'http://localhost:5173/'],
        '127.0.0.1:3000'
      )
    ).toEqual(['http://127.0.0.1:3000/', 'http://localhost:5173/']);
  });

  it('dedupes and trims recent targets', () => {
    expect(
      dedupeRecentPreviewTargets([
        '3000',
        'http://127.0.0.1:3000/',
        'localhost:5173',
      ])
    ).toEqual(['http://127.0.0.1:3000/', 'http://localhost:5173/']);
  });

  it('builds a preview bootstrap URL from the active bridge host', () => {
    expect(
      buildBrowserPreviewBootstrapUrl(
        'http://192.168.1.26:8787',
        8788,
        '/app?sid=preview&st=token'
      )
    ).toBe('http://192.168.1.26:8788/app?sid=preview&st=token&vp=mobile');
  });

  it('builds a desktop preview bootstrap URL when requested', () => {
    expect(
      buildBrowserPreviewBootstrapUrl(
        'http://192.168.1.26:8787',
        8788,
        '/app?sid=preview&st=token',
        { preset: 'desktop', width: 1440, height: 900 }
      )
    ).toBe(
      'http://192.168.1.26:8788/app?sid=preview&st=token&vp=desktop&vw=1440&vh=900'
    );
  });

  it('updates an existing preview URL with a different viewport preset', () => {
    expect(
      applyBrowserPreviewViewportPreset(
        'http://192.168.1.26:8788/dashboard?foo=bar&vp=mobile',
        { preset: 'desktop', width: 1512, height: 982 }
      )
    ).toBe(
      'http://192.168.1.26:8788/dashboard?foo=bar&vp=desktop&vw=1512&vh=982'
    );
  });

  it('preserves the current preview path while reapplying bootstrap session params', () => {
    expect(
      buildBrowserPreviewViewportNavigationUrl(
        'http://192.168.1.26:8788/settings/profile?tab=2',
        'http://192.168.1.26:8788/?sid=preview&st=token&vp=mobile',
        { preset: 'desktop', width: 1728, height: 1117 }
      )
    ).toBe(
      'http://192.168.1.26:8788/settings/profile?tab=2&sid=preview&st=token&vp=desktop&vw=1728&vh=1117'
    );
  });
});
