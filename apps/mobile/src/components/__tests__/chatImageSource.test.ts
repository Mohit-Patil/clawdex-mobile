import { toMarkdownImageSource } from '../chatImageSource';

describe('chatImageSource', () => {
  it('keeps remote https images direct', () => {
    expect(
      toMarkdownImageSource(
        'https://example.com/image.png',
        'http://192.168.1.26:8787',
        'secret-token'
      )
    ).toEqual({
      uri: 'https://example.com/image.png',
    });
  });

  it('keeps data uri images direct', () => {
    expect(
      toMarkdownImageSource(
        'data:image/png;base64,abc123',
        'http://192.168.1.26:8787',
        'secret-token'
      )
    ).toEqual({
      uri: 'data:image/png;base64,abc123',
    });
  });

  it('proxies absolute local paths through the bridge', () => {
    expect(
      toMarkdownImageSource('/tmp/My QR.png', 'http://192.168.1.26:8787', 'secret-token')
    ).toEqual({
      uri: 'http://192.168.1.26:8787/local-image?path=%2Ftmp%2FMy%20QR.png',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
  });

  it('proxies file scheme paths through the bridge', () => {
    expect(
      toMarkdownImageSource(
        'file:///Users/mohitpatil/Desktop/bridge.png',
        'http://192.168.1.26:8787',
        null
      )
    ).toEqual({
      uri: 'http://192.168.1.26:8787/local-image?path=%2FUsers%2Fmohitpatil%2FDesktop%2Fbridge.png',
    });
  });

  it('returns null for unsupported relative paths', () => {
    expect(
      toMarkdownImageSource('./relative.png', 'http://192.168.1.26:8787', 'secret-token')
    ).toBeNull();
  });
});
