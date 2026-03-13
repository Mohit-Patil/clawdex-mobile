type RemoteImageSource = {
  uri: string;
  headers?: Record<string, string>;
};

const REMOTE_SCHEME_PATTERN =
  /^(?:https?:\/\/|data:image\/|content:\/\/|assets-library:\/\/|ph:\/\/|blob:)/i;
const FILE_SCHEME_PATTERN = /^file:\/\//i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export function toMarkdownImageSource(
  rawSource: string,
  bridgeUrl: string | null | undefined,
  bridgeToken: string | null | undefined
): RemoteImageSource | null {
  const normalizedSource = rawSource.trim();
  if (!normalizedSource) {
    return null;
  }

  if (FILE_SCHEME_PATTERN.test(normalizedSource)) {
    const withoutScheme = normalizedSource.replace(FILE_SCHEME_PATTERN, '');
    return toBridgeImageSource(withoutScheme, bridgeUrl, bridgeToken);
  }

  if (REMOTE_SCHEME_PATTERN.test(normalizedSource)) {
    return { uri: normalizedSource };
  }

  if (normalizedSource.startsWith('/') || WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedSource)) {
    return toBridgeImageSource(normalizedSource, bridgeUrl, bridgeToken);
  }

  return null;
}

function toBridgeImageSource(
  rawPath: string,
  bridgeUrl: string | null | undefined,
  bridgeToken: string | null | undefined
): RemoteImageSource | null {
  const normalizedBridgeUrl = bridgeUrl?.trim();
  if (!normalizedBridgeUrl) {
    return null;
  }

  const normalizedPath = normalizeLocalPath(rawPath);
  if (!normalizedPath) {
    return null;
  }

  const uri = `${normalizedBridgeUrl.replace(/\/$/, '')}/local-image?path=${encodeURIComponent(
    normalizedPath
  )}`;
  const token = bridgeToken?.trim();

  return token
    ? {
        uri,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    : { uri };
}

function normalizeLocalPath(rawPath: string): string | null {
  let normalizedPath = rawPath.trim();
  if (!normalizedPath) {
    return null;
  }

  normalizedPath = normalizedPath.replace(/\\/g, '/');

  try {
    normalizedPath = decodeURI(normalizedPath);
  } catch {
    // Keep original path when URI decoding fails.
  }

  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedPath) && !normalizedPath.startsWith('/')) {
    normalizedPath = `/${normalizedPath}`;
  }

  return normalizedPath;
}
