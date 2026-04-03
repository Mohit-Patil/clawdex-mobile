const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_PREVIEW_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[^\s<>"')\]]*)?/gi;
const LOCAL_PREVIEW_WITHOUT_SCHEME_PATTERN =
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const PORT_ONLY_PATTERN = /^\d{2,5}$/;
const MAX_RECENT_TARGETS = 8;
export type BrowserPreviewViewportPreset = 'mobile' | 'desktop';
export interface BrowserPreviewViewportSpec {
  preset: BrowserPreviewViewportPreset;
  width?: number | null;
  height?: number | null;
}

const DEFAULT_BROWSER_PREVIEW_VIEWPORT: BrowserPreviewViewportSpec = {
  preset: 'mobile',
};
const MIN_BROWSER_PREVIEW_VIEWPORT_SIZE = 320;
const MAX_BROWSER_PREVIEW_VIEWPORT_SIZE = 4096;

function normalizeViewportDimension(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.round(value);
  if (
    normalized < MIN_BROWSER_PREVIEW_VIEWPORT_SIZE ||
    normalized > MAX_BROWSER_PREVIEW_VIEWPORT_SIZE
  ) {
    return undefined;
  }

  return normalized;
}

export function normalizeBrowserPreviewViewportSpec(
  viewport: BrowserPreviewViewportSpec | null | undefined
): BrowserPreviewViewportSpec {
  if (!viewport || viewport.preset !== 'desktop') {
    return DEFAULT_BROWSER_PREVIEW_VIEWPORT;
  }

  return {
    preset: 'desktop',
    width: normalizeViewportDimension(viewport.width),
    height: normalizeViewportDimension(viewport.height),
  };
}

export function normalizePreviewTargetInput(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = PORT_ONLY_PATTERN.test(trimmed)
    ? `http://127.0.0.1:${trimmed}`
    : LOCAL_PREVIEW_WITHOUT_SCHEME_PATTERN.test(trimmed)
      ? `http://${trimmed}`
      : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.host.trim().toLowerCase();
  const hostname = parsed.hostname.trim().toLowerCase();
  if (
    !LOOPBACK_HOSTS.has(host) &&
    !LOOPBACK_HOSTS.has(hostname)
  ) {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  parsed.hash = '';
  if (!parsed.pathname) {
    parsed.pathname = '/';
  }

  return parsed.toString();
}

export function isLocalPreviewCandidateUrl(value: string): boolean {
  return normalizePreviewTargetInput(value) !== null;
}

export function extractLocalPreviewUrls(value: string): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const matches = value.match(LOCAL_PREVIEW_URL_PATTERN) ?? [];
  return dedupeRecentPreviewTargets(
    matches
      .map((match) => normalizePreviewTargetInput(match))
      .filter((entry): entry is string => typeof entry === 'string')
  );
}

export function dedupeRecentPreviewTargets(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizePreviewTargetInput(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= MAX_RECENT_TARGETS) {
      break;
    }
  }

  return deduped;
}

export function pushRecentPreviewTarget(
  currentValues: string[],
  nextValue: string
): string[] {
  const normalized = normalizePreviewTargetInput(nextValue);
  if (!normalized) {
    return dedupeRecentPreviewTargets(currentValues);
  }

  return dedupeRecentPreviewTargets([normalized, ...currentValues]);
}

export function buildBrowserPreviewBootstrapUrl(
  bridgeUrl: string,
  previewPort: number,
  bootstrapPath: string,
  viewport: BrowserPreviewViewportSpec = DEFAULT_BROWSER_PREVIEW_VIEWPORT
): string | null {
  if (typeof bridgeUrl !== 'string' || typeof bootstrapPath !== 'string') {
    return null;
  }

  const normalizedBridgeUrl = bridgeUrl.trim();
  const normalizedPath = bootstrapPath.trim();
  if (!normalizedBridgeUrl || !normalizedPath) {
    return null;
  }

  try {
    const normalizedViewport = normalizeBrowserPreviewViewportSpec(viewport);
    const base = new URL(normalizedBridgeUrl);
    base.port = String(previewPort);
    base.pathname = '/';
    base.search = '';
    base.hash = '';

    const previewUrl = new URL(
      normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`,
      base.toString()
    );
    applyViewportParams(previewUrl, normalizedViewport);
    return previewUrl.toString();
  } catch {
    return null;
  }
}

export function getBrowserPreviewOrigin(
  bridgeUrl: string,
  previewPort: number
): string | null {
  if (typeof bridgeUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(bridgeUrl.trim());
    parsed.port = String(previewPort);
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isSameOriginUrl(url: string, origin: string | null | undefined): boolean {
  if (!origin) {
    return false;
  }

  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function applyBrowserPreviewViewportPreset(
  rawUrl: string,
  viewport: BrowserPreviewViewportSpec
): string | null {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    applyViewportParams(parsed, normalizeBrowserPreviewViewportSpec(viewport));
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildBrowserPreviewViewportNavigationUrl(
  rawCurrentUrl: string,
  rawBootstrapUrl: string,
  viewport: BrowserPreviewViewportSpec
): string | null {
  if (typeof rawCurrentUrl !== 'string' || typeof rawBootstrapUrl !== 'string') {
    return null;
  }

  try {
    const normalizedViewport = normalizeBrowserPreviewViewportSpec(viewport);
    const current = new URL(rawCurrentUrl.trim());
    const bootstrap = new URL(rawBootstrapUrl.trim());
    const sid = bootstrap.searchParams.get('sid');
    const st = bootstrap.searchParams.get('st');

    if (current.origin !== bootstrap.origin || !sid || !st) {
      return applyBrowserPreviewViewportPreset(rawBootstrapUrl, normalizedViewport);
    }

    current.searchParams.set('sid', sid);
    current.searchParams.set('st', st);
    applyViewportParams(current, normalizedViewport);
    return current.toString();
  } catch {
    return applyBrowserPreviewViewportPreset(rawBootstrapUrl, viewport);
  }
}

function applyViewportParams(url: URL, viewport: BrowserPreviewViewportSpec): void {
  url.searchParams.set('vp', viewport.preset);
  if (viewport.preset === 'desktop') {
    const width = normalizeViewportDimension(viewport.width);
    const height = normalizeViewportDimension(viewport.height);
    if (width) {
      url.searchParams.set('vw', String(width));
    } else {
      url.searchParams.delete('vw');
    }
    if (height) {
      url.searchParams.set('vh', String(height));
    } else {
      url.searchParams.delete('vh');
    }
    return;
  }

  url.searchParams.delete('vw');
  url.searchParams.delete('vh');
}
