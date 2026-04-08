import { Ionicons } from '@expo/vector-icons';
import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ActivityIndicator,
  Animated as RNAnimated,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Modal,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from 'react-native-webview';

import type { HostBridgeApiClient } from '../api/client';
import type {
  BrowserPreviewDiscoveryResponse,
  BrowserPreviewSession,
  BrowserPreviewTargetSuggestion,
} from '../api/types';
import {
  applyBrowserPreviewShellMode,
  buildBrowserPreviewBootstrapUrl,
  type BrowserPreviewViewportSpec,
  getBrowserPreviewShellRequestKey,
  getBrowserPreviewOrigin,
  isLocalPreviewCandidateUrl,
  isSameOriginUrl,
  mapBrowserPreviewNavigationUrlToTargetUrl,
  normalizePreviewTargetInput,
  pushRecentPreviewTarget,
} from '../browserPreview';
import { useAppTheme, type AppTheme } from '../theme';

interface BrowserScreenProps {
  api: HostBridgeApiClient;
  bridgeUrl: string;
  onOpenDrawer: () => void;
  recentTargetUrls: string[];
  onRecentTargetUrlsChange: (targets: string[]) => void;
  pendingTargetUrl?: string | null;
  onPendingTargetHandled?: () => void;
}

export interface BrowserScreenHandle {
  handleHardwareBackPress: () => boolean;
}

type WebViewScrollEvent = NativeSyntheticEvent<
  Readonly<{
    contentOffset: {
      x: number;
      y: number;
    };
  }>
>;

type ViewportPreset = 'mobile' | 'desktop' | 'desktop2';
type DesktopFrameMessage = {
  type: 'clawdexDesktopFrameState';
  shellRequestKey?: string | null;
  rawUrl?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

const DEFAULT_DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
const DESKTOP_VIEWPORT_PRESETS = [
  { label: '1920×1080', width: 1920, height: 1080 },
  { label: '1366×768', width: 1366, height: 768 },
  { label: '1440×900', width: 1440, height: 900 },
  { label: '1512×982', width: 1512, height: 982 },
  { label: '1728×1117', width: 1728, height: 1117 },
];
const DESKTOP_PREVIEW_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

export const BrowserScreen = forwardRef<BrowserScreenHandle, BrowserScreenProps>(
  function BrowserScreen(
    {
      api,
      bridgeUrl,
      onOpenDrawer,
      recentTargetUrls,
      onRecentTargetUrlsChange,
      pendingTargetUrl = null,
      onPendingTargetHandled,
    },
    ref
  ) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const desktopScrollViewRef = useRef<ScrollView>(null);
  const bottomBarTranslateY = useRef(new RNAnimated.Value(0)).current;
  const lastDesktopFitKeyRef = useRef<string | null>(null);
  const overviewHeightLockedRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const [inputValue, setInputValue] = useState(
    recentTargetUrls[0] ?? 'http://127.0.0.1:3000'
  );
  const [activeSession, setActiveSession] = useState<BrowserPreviewSession | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [, setCurrentPreviewNavigationUrl] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [openingPreview, setOpeningPreview] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<BrowserPreviewTargetSuggestion[]>([]);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [supportsBrowserPreview, setSupportsBrowserPreview] = useState(true);
  const [webReloadKey, setWebReloadKey] = useState(0);
  const [nativeReloadKey, setNativeReloadKey] = useState(0);
  const [bottomBarVisible, setBottomBarVisible] = useState(true);
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>('mobile');
  const [desktopViewportSize, setDesktopViewportSize] = useState(DEFAULT_DESKTOP_VIEWPORT);
  const [desktopViewportDraft, setDesktopViewportDraft] = useState({
    width: String(DEFAULT_DESKTOP_VIEWPORT.width),
    height: String(DEFAULT_DESKTOP_VIEWPORT.height),
  });
  const [showCustomViewportEditor, setShowCustomViewportEditor] = useState(false);
  const [showViewportMenu, setShowViewportMenu] = useState(false);
  const [nativePreviewLayout, setNativePreviewLayout] = useState({ width: 0, height: 0 });
  const [overviewMetrics, setOverviewMetrics] = useState<{
    previewUrl: string;
    height: number;
  } | null>(null);

  const previewOrigin = useMemo(
    () =>
      activeSession ? getBrowserPreviewOrigin(bridgeUrl, activeSession.previewPort) : null,
    [activeSession, bridgeUrl]
  );
  const currentShellRequestKey = useMemo(
    () => getBrowserPreviewShellRequestKey(previewUrl),
    [previewUrl]
  );
  const siteLabel = useMemo(
    () => getCompactBrowserLabel(currentUrl ?? activeSession?.targetUrl ?? inputValue),
    [activeSession?.targetUrl, currentUrl, inputValue]
  );
  const desktopModeEnabled = viewportPreset !== 'mobile';
  const nativeShellMode: 'desktop' | 'overview' | null =
    Platform.OS === 'ios'
      ? viewportPreset === 'desktop'
        ? 'overview'
        : viewportPreset === 'desktop2'
          ? 'desktop'
          : null
      : null;
  const desktopOverviewEnabled = desktopModeEnabled && nativeShellMode !== 'desktop';
  const nativeOverviewShellEnabled = nativeShellMode === 'overview';
  const iframeStyle = useMemo<CSSProperties>(
    () => ({
      border: 0,
      width: desktopModeEnabled ? `${desktopViewportSize.width}px` : '100%',
      height: '100%',
      display: 'block',
      backgroundColor: theme.colors.bgMain,
    }),
    [desktopModeEnabled, desktopViewportSize.width, theme.colors.bgMain]
  );
  const bottomBarInset =
    insets.bottom > 0
      ? Math.max(insets.bottom - theme.spacing.md, theme.spacing.xs)
      : theme.spacing.xs;
  const bottomBarReservedSpace = bottomBarInset + 58;
  const webViewBottomInset = bottomBarVisible ? bottomBarReservedSpace : 0;
  const nativeUserAgent =
    Platform.OS === 'web' || Platform.OS === 'ios' || !desktopModeEnabled
      ? undefined
      : DESKTOP_PREVIEW_USER_AGENT;
  const nativeContentMode =
    Platform.OS === 'ios'
      ? undefined
      : desktopModeEnabled
        ? 'desktop'
        : 'mobile';
  const browserViewport = useMemo<BrowserPreviewViewportSpec>(
    () =>
      desktopModeEnabled
        ? {
            preset: 'desktop',
            width: desktopViewportSize.width,
            height: desktopViewportSize.height,
          }
        : { preset: 'mobile' },
    [desktopModeEnabled, desktopViewportSize.height, desktopViewportSize.width]
  );
  const desktopViewportLabel = `${desktopViewportSize.width}×${desktopViewportSize.height}`;
  const desktopViewportMatchesPreset = DESKTOP_VIEWPORT_PRESETS.some(
    (preset) =>
      preset.width === desktopViewportSize.width && preset.height === desktopViewportSize.height
  );
  const overviewContentHeight =
    desktopOverviewEnabled &&
    !nativeOverviewShellEnabled &&
    previewUrl &&
    overviewMetrics?.previewUrl === previewUrl
      ? overviewMetrics.height
      : null;
  const desktopCanvasHeight =
    desktopOverviewEnabled && overviewContentHeight
      ? Math.max(desktopViewportSize.height, overviewContentHeight)
      : desktopViewportSize.height;
  const overviewReady =
    nativeOverviewShellEnabled || !desktopOverviewEnabled || overviewContentHeight !== null;
  const desktopMinimumZoomScale =
    Platform.OS === 'ios' && nativePreviewLayout.width > 0
      ? Math.min(
          1,
          nativePreviewLayout.width / desktopViewportSize.width,
          nativePreviewLayout.height / desktopCanvasHeight
        )
      : 1;
  const desktopInitialZoomScale =
    Platform.OS === 'ios' && nativePreviewLayout.height > 0
      ? desktopOverviewEnabled
        ? desktopMinimumZoomScale
        : Math.min(1, nativePreviewLayout.height / desktopCanvasHeight)
      : 1;

  useEffect(() => {
    overviewHeightLockedRef.current = false;
    lastDesktopFitKeyRef.current = null;
    setOverviewMetrics(null);
  }, [desktopViewportSize.height, desktopViewportSize.width, previewUrl, viewportPreset]);

  useEffect(() => {
    RNAnimated.timing(bottomBarTranslateY, {
      toValue: bottomBarVisible ? 0 : bottomBarReservedSpace + theme.spacing.sm,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [bottomBarReservedSpace, bottomBarTranslateY, bottomBarVisible, theme.spacing.sm]);

  useEffect(() => {
    if (
      Platform.OS !== 'ios' ||
      !desktopOverviewEnabled ||
      nativeOverviewShellEnabled ||
      !previewUrl ||
      loadingPreview ||
      nativePreviewLayout.width <= 0 ||
      nativePreviewLayout.height <= 0 ||
      !overviewReady
    ) {
      lastDesktopFitKeyRef.current = null;
      return;
    }

    const fitKey = [
      viewportPreset,
      previewUrl,
      desktopViewportSize.width,
      desktopViewportSize.height,
      desktopCanvasHeight,
      nativePreviewLayout.width,
      nativePreviewLayout.height,
    ].join('|');
    if (lastDesktopFitKeyRef.current === fitKey) {
      return;
    }

    lastDesktopFitKeyRef.current = fitKey;
    const timeout = setTimeout(() => {
      desktopScrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
      setTimeout(() => {
        desktopScrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
        if (desktopOverviewEnabled) {
          overviewHeightLockedRef.current = true;
        }
      }, 32);
    }, 0);

    return () => clearTimeout(timeout);
  }, [
    desktopCanvasHeight,
    desktopInitialZoomScale,
    desktopOverviewEnabled,
    nativeOverviewShellEnabled,
    loadingPreview,
    overviewReady,
    viewportPreset,
    desktopViewportSize.height,
    desktopViewportSize.width,
    nativePreviewLayout.height,
    nativePreviewLayout.width,
    previewUrl,
  ]);

  const loadBrowserCapabilities = useCallback(async () => {
    try {
      const capabilities = await api.readBridgeCapabilities();
      setSupportsBrowserPreview(capabilities.supports.browserPreview !== false);
      setCapabilitiesError(null);
    } catch (error) {
      setSupportsBrowserPreview(true);
      setCapabilitiesError(
        error instanceof Error ? error.message : 'Could not load bridge capabilities.'
      );
    }
  }, [api]);

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const response: BrowserPreviewDiscoveryResponse =
        await api.discoverBrowserPreviewTargets();
      setSuggestions(response.suggestions);
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadBrowserCapabilities();
    void loadSuggestions();
  }, [loadBrowserCapabilities, loadSuggestions]);

  const startPreviewSession = useCallback(
    async (rawTarget: string, viewport: BrowserPreviewViewportSpec) => {
      const normalizedTarget = normalizePreviewTargetInput(rawTarget);
      if (!normalizedTarget) {
        throw new Error('Use a loopback URL like localhost:3000 or just enter a port.');
      }

      const session = await api.createBrowserPreviewSession(normalizedTarget);
      const nextPreviewUrl = buildBrowserPreviewBootstrapUrl(
        bridgeUrl,
        session.previewPort,
        session.bootstrapPath,
        viewport
      );
      if (!nextPreviewUrl) {
        throw new Error('Could not build preview bootstrap URL.');
      }

      return {
        normalizedTarget,
        session,
        nextPreviewUrl,
      };
    },
    [api, bridgeUrl]
  );

  const openPreview = useCallback(
    async (rawTarget: string) => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;
      setOpeningPreview(true);
      setLoadingPreview(true);
      setCapabilitiesError(null);
      try {
        const { normalizedTarget, session, nextPreviewUrl } = await startPreviewSession(
          rawTarget,
          browserViewport
        );
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        const resolvedPreviewUrl =
          applyBrowserPreviewShellMode(nextPreviewUrl, nativeShellMode) ??
          nextPreviewUrl;

        setInputValue(normalizedTarget);
        setActiveSession(session);
        setPreviewUrl(resolvedPreviewUrl);
        setCurrentPreviewNavigationUrl(resolvedPreviewUrl);
        setCurrentUrl(normalizedTarget);
        setPageTitle(null);
        setCanGoBack(false);
        setCanGoForward(false);
        setBottomBarVisible(true);
        lastScrollYRef.current = 0;
        setWebReloadKey((value) => value + 1);
        setNativeReloadKey((value) => value + 1);
        onRecentTargetUrlsChange(pushRecentPreviewTarget(recentTargetUrls, normalizedTarget));
      } catch (error) {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setLoadingPreview(false);
        setCapabilitiesError(
          error instanceof Error ? error.message : 'Could not open local preview.'
        );
      } finally {
        if (previewRequestIdRef.current === requestId) {
          setOpeningPreview(false);
        }
      }
    },
    [
      browserViewport,
      nativeShellMode,
      onRecentTargetUrlsChange,
      recentTargetUrls,
      startPreviewSession,
    ]
  );

  useEffect(() => {
    if (!pendingTargetUrl) {
      return;
    }

    setInputValue(pendingTargetUrl);
    void openPreview(pendingTargetUrl);
    onPendingTargetHandled?.();
  }, [onPendingTargetHandled, openPreview, pendingTargetUrl]);

  const handleNavigationStateChange = useCallback(
    (navigation: WebViewNavigation) => {
      if (nativeShellMode) {
        return;
      }

      const nextUrl = navigation.url || null;
      setCurrentPreviewNavigationUrl(nextUrl);
      const nextDisplayUrl =
        nextUrl && activeSession?.targetUrl
          ? mapBrowserPreviewNavigationUrlToTargetUrl(
              nextUrl,
              previewOrigin,
              activeSession.targetUrl
            ) ?? nextUrl
          : nextUrl;
      setCurrentUrl(nextDisplayUrl);
      if (nextDisplayUrl) {
        setInputValue(nextDisplayUrl);
      }
      setPageTitle(navigation.title || null);
      setCanGoBack(navigation.canGoBack);
      setCanGoForward(navigation.canGoForward);
      setLoadingPreview(navigation.loading);
    },
    [activeSession?.targetUrl, nativeShellMode, previewOrigin]
  );

  const handleDesktopFrameMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let payload: DesktopFrameMessage | null = null;
      try {
        payload = JSON.parse(event.nativeEvent.data) as DesktopFrameMessage;
      } catch {
        return;
      }

      if (!payload || payload.type !== 'clawdexDesktopFrameState' || !activeSession?.targetUrl) {
        return;
      }
      if (currentShellRequestKey && payload.shellRequestKey !== currentShellRequestKey) {
        return;
      }

      const rawUrl = typeof payload.rawUrl === 'string' && payload.rawUrl ? payload.rawUrl : null;
      const nextDisplayUrl =
        rawUrl && previewOrigin
          ? mapBrowserPreviewNavigationUrlToTargetUrl(
              rawUrl,
              previewOrigin,
              activeSession.targetUrl
            ) ?? rawUrl
          : activeSession.targetUrl;
      setCurrentPreviewNavigationUrl(rawUrl);
      setCurrentUrl(nextDisplayUrl);
      setInputValue(nextDisplayUrl);
      setPageTitle(typeof payload.title === 'string' ? payload.title : null);
      setCanGoBack(Boolean(payload.canGoBack));
      setCanGoForward(Boolean(payload.canGoForward));
      setLoadingPreview(false);
    },
    [activeSession?.targetUrl, currentShellRequestKey, previewOrigin]
  );

  const executeDesktopFrameCommand = useCallback((command: 'goBack' | 'goForward' | 'reload') => {
    webViewRef.current?.injectJavaScript(
      `window.__clawdexDesktopFrame && window.__clawdexDesktopFrame.${command} && window.__clawdexDesktopFrame.${command}(); true;`
    );
  }, []);

  const handleShouldStartLoad = useCallback(
    (request: { url: string }) => {
      const requestedUrl = request.url;
      if (
        requestedUrl === 'about:blank' ||
        requestedUrl.startsWith('data:') ||
        requestedUrl.startsWith('blob:')
      ) {
        return true;
      }

      if (isSameOriginUrl(requestedUrl, previewOrigin)) {
        return true;
      }

      if (isLocalPreviewCandidateUrl(requestedUrl)) {
        setInputValue(requestedUrl);
        setTimeout(() => {
          void openPreview(requestedUrl);
        }, 0);
      }

      return false;
    },
    [openPreview, previewOrigin]
  );

  const handleSubmitInput = useCallback(() => {
    void openPreview(inputValue);
  }, [inputValue, openPreview]);

  const handleReload = useCallback(() => {
    if (!previewUrl) {
      void loadSuggestions();
      return;
    }

    setCapabilitiesError(null);
    setLoadingPreview(true);
    if (Platform.OS === 'web') {
      setWebReloadKey((value) => value + 1);
      return;
    }

    if (nativeShellMode) {
      executeDesktopFrameCommand('reload');
      return;
    }

    webViewRef.current?.reload();
  }, [executeDesktopFrameCommand, loadSuggestions, nativeShellMode, previewUrl]);

  const handleGoBackPress = useCallback(() => {
    if (nativeShellMode) {
      executeDesktopFrameCommand('goBack');
      return;
    }

    webViewRef.current?.goBack();
  }, [executeDesktopFrameCommand, nativeShellMode]);

  const handleGoForwardPress = useCallback(() => {
    if (nativeShellMode) {
      executeDesktopFrameCommand('goForward');
      return;
    }

    webViewRef.current?.goForward();
  }, [executeDesktopFrameCommand, nativeShellMode]);

  useImperativeHandle(
    ref,
    () => ({
      handleHardwareBackPress: () => {
        if (!previewUrl || !canGoBack) {
          return false;
        }
        handleGoBackPress();
        return true;
      },
    }),
    [canGoBack, handleGoBackPress, previewUrl]
  );

  const handleShowStartPage = useCallback(() => {
    previewRequestIdRef.current += 1;
    setPreviewUrl(null);
    setActiveSession(null);
    setCurrentPreviewNavigationUrl(null);
    setCurrentUrl(null);
    setPageTitle(null);
    setCanGoBack(false);
    setCanGoForward(false);
    setLoadingPreview(false);
    setBottomBarVisible(true);
    lastScrollYRef.current = 0;
  }, []);

  const handleContentProcessDidTerminate = useCallback(() => {
    if (nativeShellMode) {
      setLoadingPreview(false);
      return;
    }

    setLoadingPreview(true);
    setBottomBarVisible(true);
    lastScrollYRef.current = 0;
    setNativeReloadKey((value) => value + 1);
  }, [nativeShellMode]);

  const handleWebViewScroll = useCallback(
    (event: WebViewScrollEvent) => {
      const nextY = event.nativeEvent.contentOffset.y;
      const delta = nextY - lastScrollYRef.current;
      lastScrollYRef.current = nextY;

      if (nextY <= 8) {
        if (!bottomBarVisible) {
          setBottomBarVisible(true);
        }
        return;
      }

      if (Math.abs(delta) < 8) {
        return;
      }

      if (delta > 0) {
        if (bottomBarVisible) {
          setBottomBarVisible(false);
        }
        return;
      }

      if (!bottomBarVisible) {
        setBottomBarVisible(true);
      }
    },
    [bottomBarVisible]
  );

  const handleNativePreviewViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    if (nextWidth <= 0 || nextHeight <= 0) {
      return;
    }

    setNativePreviewLayout((current) =>
      current.width === nextWidth && current.height === nextHeight
        ? current
        : { width: nextWidth, height: nextHeight }
    );
  }, []);

  const handleOverviewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!desktopOverviewEnabled || nativeOverviewShellEnabled) {
        return;
      }

      try {
        const payload = JSON.parse(event.nativeEvent.data) as {
          type?: string;
          height?: number;
        };
        if (payload.type !== 'clawdexOverviewMetrics') {
          return;
        }

        const nextHeight = Math.round(Number(payload.height));
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
          return;
        }

        const normalizedHeight = Math.max(desktopViewportSize.height, nextHeight);
        setOverviewMetrics((current) => {
          if (overviewHeightLockedRef.current) {
            return current;
          }
          if (current?.previewUrl === previewUrl && current.height === normalizedHeight) {
            return current;
          }
          return {
            previewUrl: previewUrl ?? '',
            height:
              current?.previewUrl === previewUrl
                ? Math.max(current.height, normalizedHeight)
                : normalizedHeight,
          };
        });
      } catch {
        return;
      }
    },
    [desktopOverviewEnabled, desktopViewportSize.height, nativeOverviewShellEnabled]
  );

  const overviewInjectedJavaScript = useMemo(
    () => `
      (function() {
        if (window.__clawdexOverviewMetricsInstalled) {
          true;
          return;
        }
        window.__clawdexOverviewMetricsInstalled = true;
        var lastHeight = 0;
        function readHeight() {
          var doc = document.documentElement;
          var body = document.body;
          return Math.max(
            Math.ceil(doc ? doc.scrollHeight : 0),
            Math.ceil(body ? body.scrollHeight : 0),
            Math.ceil(window.innerHeight || 0)
          );
        }
        function postHeight() {
          var nextHeight = readHeight();
          if (!nextHeight || nextHeight === lastHeight) {
            return;
          }
          lastHeight = nextHeight;
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'clawdexOverviewMetrics',
              height: nextHeight
            }));
          }
        }
        if (typeof ResizeObserver === 'function') {
          var resizeObserver = new ResizeObserver(function() {
            postHeight();
          });
          if (document.documentElement) {
            resizeObserver.observe(document.documentElement);
          }
          if (document.body) {
            resizeObserver.observe(document.body);
          }
        }
        if (typeof MutationObserver === 'function' && document.documentElement) {
          var mutationObserver = new MutationObserver(function() {
            postHeight();
          });
          mutationObserver.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
          });
        }
        window.addEventListener('load', postHeight);
        window.addEventListener('resize', postHeight);
        setTimeout(postHeight, 0);
        setTimeout(postHeight, 300);
        setTimeout(postHeight, 1000);
        true;
      })();
    `,
    []
  );

  const applyViewportSelection = useCallback(
    (nextPreset: ViewportPreset, nextDesktopViewport = desktopViewportSize) => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;
      const nextViewport =
        nextPreset !== 'mobile'
          ? {
              preset: 'desktop' as const,
              width: nextDesktopViewport.width,
              height: nextDesktopViewport.height,
            }
          : { preset: 'mobile' as const };
      const reloadTarget =
        currentUrl ?? activeSession?.targetUrl ?? inputValue;
      const commitViewportSelectionState = () => {
        setViewportPreset(nextPreset);
        setBottomBarVisible(true);
        lastScrollYRef.current = 0;
        lastDesktopFitKeyRef.current = null;
        overviewHeightLockedRef.current = false;
        setOverviewMetrics(null);
        setCurrentPreviewNavigationUrl(null);
        setPageTitle(null);
        setCanGoBack(false);
        setCanGoForward(false);

        if (nextPreset !== 'mobile') {
          setDesktopViewportSize(nextDesktopViewport);
          setDesktopViewportDraft({
            width: String(nextDesktopViewport.width),
            height: String(nextDesktopViewport.height),
          });
        } else {
          setShowCustomViewportEditor(false);
        }
      };

      if (!previewUrl) {
        commitViewportSelectionState();
        return;
      }

      const normalizedReloadTarget = normalizePreviewTargetInput(reloadTarget);
      if (!normalizedReloadTarget) {
        commitViewportSelectionState();
        return;
      }

      setOpeningPreview(true);
      setLoadingPreview(true);
      setCapabilitiesError(null);
      void startPreviewSession(normalizedReloadTarget, nextViewport)
        .then(({ normalizedTarget, session, nextPreviewUrl }) => {
          if (previewRequestIdRef.current !== requestId) {
            return;
          }
          const nextShellMode: 'desktop' | 'overview' | null =
            Platform.OS === 'ios'
              ? nextPreset === 'desktop'
                ? 'overview'
                : nextPreset === 'desktop2'
                  ? 'desktop'
                  : null
              : null;
          const resolvedPreviewUrl =
            applyBrowserPreviewShellMode(nextPreviewUrl, nextShellMode) ?? nextPreviewUrl;
          commitViewportSelectionState();
          setInputValue(normalizedTarget);
          setActiveSession(session);
          setPreviewUrl(resolvedPreviewUrl);
          setCurrentPreviewNavigationUrl(resolvedPreviewUrl);
          setCurrentUrl(normalizedTarget);
          setPageTitle(null);
          setCanGoBack(false);
          setCanGoForward(false);
          setWebReloadKey((value) => value + 1);
          setNativeReloadKey((value) => value + 1);
        })
        .catch((error) => {
          if (previewRequestIdRef.current !== requestId) {
            return;
          }
          setLoadingPreview(false);
          setCapabilitiesError(
            error instanceof Error ? error.message : 'Could not reload local preview.'
          );
        })
        .finally(() => {
          if (previewRequestIdRef.current === requestId) {
            setOpeningPreview(false);
          }
        });
    },
    [activeSession?.targetUrl, currentUrl, desktopViewportSize, inputValue, previewUrl, startPreviewSession]
  );

  const handleSelectDesktopPreset = useCallback(
    (viewport: { width: number; height: number }) => {
      setDesktopViewportSize(viewport);
      setDesktopViewportDraft({
        width: String(viewport.width),
        height: String(viewport.height),
      });
      setShowCustomViewportEditor(false);
      setShowViewportMenu(false);
      if (viewportPreset !== 'mobile' && previewUrl) {
        applyViewportSelection(viewportPreset, viewport);
      }
    },
    [applyViewportSelection, previewUrl, viewportPreset]
  );

  const handleOpenViewportMenu = useCallback(() => {
    setDesktopViewportDraft({
      width: String(desktopViewportSize.width),
      height: String(desktopViewportSize.height),
    });
    setShowViewportMenu(true);
  }, [desktopViewportSize.height, desktopViewportSize.width]);

  const handleCloseViewportMenu = useCallback(() => {
    setShowViewportMenu(false);
    setShowCustomViewportEditor(false);
  }, []);

  const handleShowCustomViewportEditor = useCallback(() => {
    setDesktopViewportDraft({
      width: String(desktopViewportSize.width),
      height: String(desktopViewportSize.height),
    });
    setShowViewportMenu(true);
    setShowCustomViewportEditor(true);
  }, [desktopViewportSize.height, desktopViewportSize.width]);

  const handleApplyDesktopViewport = useCallback(() => {
    const width = parseDesktopViewportValue(desktopViewportDraft.width);
    const height = parseDesktopViewportValue(desktopViewportDraft.height);

    if (!width || !height) {
      setCapabilitiesError('Use desktop viewport values between 320 and 4096.');
      return;
    }

    setCapabilitiesError(null);
    setDesktopViewportSize({ width, height });
    setDesktopViewportDraft({ width: String(width), height: String(height) });
    setShowCustomViewportEditor(false);
    setShowViewportMenu(false);
    if (viewportPreset !== 'mobile' && previewUrl) {
      applyViewportSelection(viewportPreset, { width, height });
    }
  }, [
    applyViewportSelection,
    desktopViewportDraft.height,
    desktopViewportDraft.width,
    previewUrl,
    viewportPreset,
  ]);

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.chrome}>
          <View style={styles.topBar}>
            <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.chromeButton}>
              <Ionicons name="menu" size={20} color={colors.textPrimary} />
            </Pressable>

            <View style={styles.omnibox}>
              <Ionicons
                name={previewUrl ? 'globe-outline' : 'search-outline'}
                size={16}
                color={colors.textMuted}
              />
              <TextInput
                value={inputValue}
                onChangeText={setInputValue}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Search localhost or enter a port"
                placeholderTextColor={colors.textMuted}
                style={styles.omniboxInput}
                onSubmitEditing={handleSubmitInput}
              />
              {inputValue.length > 0 ? (
                <Pressable
                  onPress={() => setInputValue('')}
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.omniboxIconButton,
                    pressed && styles.iconButtonPressed,
                  ]}
                >
                  <Ionicons name="close" size={14} color={colors.textMuted} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={handleSubmitInput}
                disabled={!supportsBrowserPreview || openingPreview}
                style={({ pressed }) => [
                  styles.submitButton,
                  (!supportsBrowserPreview || openingPreview) && styles.submitButtonDisabled,
                  pressed && supportsBrowserPreview && !openingPreview && styles.submitButtonPressed,
                ]}
              >
                {openingPreview ? (
                  <ActivityIndicator size="small" color={colors.accentText} />
                ) : (
                  <Ionicons name="arrow-forward" size={16} color={colors.accentText} />
                )}
              </Pressable>
            </View>
          </View>
          {previewUrl ? (
            <View style={styles.viewportTray}>
              <View style={styles.viewportModeRow}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.viewportModeScroller}
                  contentContainerStyle={styles.viewportPresetRow}
                >
                  {([
                    { key: 'mobile', label: 'Mobile' },
                    { key: 'desktop', label: 'Desktop' },
                    { key: 'desktop2', label: 'Desktop Full' },
                  ] as const).map((mode) => (
                    <Pressable
                      key={mode.key}
                      onPress={() => applyViewportSelection(mode.key)}
                      style={({ pressed }) => [
                        styles.viewportPresetChip,
                        viewportPreset === mode.key && styles.viewportPresetChipActive,
                        pressed && styles.viewportPresetChipPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.viewportPresetChipText,
                          viewportPreset === mode.key && styles.viewportPresetChipTextActive,
                        ]}
                      >
                        {mode.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Pressable
                  onPress={handleOpenViewportMenu}
                  style={({ pressed }) => [
                    styles.viewportSettingsButton,
                    (desktopModeEnabled || showViewportMenu) && styles.viewportPresetChipActive,
                    pressed && styles.viewportPresetChipPressed,
                  ]}
                >
                  <Ionicons
                    name="options-outline"
                    size={14}
                    color={
                      desktopModeEnabled || showViewportMenu
                        ? colors.textPrimary
                        : colors.textSecondary
                    }
                  />
                  <Text
                    style={[
                      styles.viewportPresetChipText,
                      (desktopModeEnabled || showViewportMenu) &&
                        styles.viewportPresetChipTextActive,
                    ]}
                  >
                    {desktopViewportLabel}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>

        {capabilitiesError ? (
          <StatusBanner tone="error" message={capabilitiesError} />
        ) : null}
        {!supportsBrowserPreview ? (
          <StatusBanner
            tone="warning"
            message="This bridge did not start its preview server. Check bridge logs for preview port conflicts."
          />
        ) : null}

        <Modal
          visible={showViewportMenu}
          transparent
          animationType="fade"
          onRequestClose={handleCloseViewportMenu}
        >
          <Pressable style={styles.viewportMenuBackdrop} onPress={handleCloseViewportMenu}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'position' : undefined}
              style={styles.viewportMenuKeyboardLayer}
            >
              <Pressable style={styles.viewportMenuCard} onPress={() => {}}>
                <View style={styles.viewportMenuHeader}>
                  <Text style={styles.viewportMenuTitle}>Viewport</Text>
                  <Text style={styles.viewportMenuSubtitle}>
                    Applies to Desktop.
                  </Text>
                </View>
                <View style={styles.viewportMenuPresetGrid}>
                  {DESKTOP_VIEWPORT_PRESETS.map((preset) => {
                    const active =
                      desktopViewportSize.width === preset.width &&
                      desktopViewportSize.height === preset.height;
                    return (
                      <Pressable
                        key={preset.label}
                        onPress={() => handleSelectDesktopPreset(preset)}
                        style={({ pressed }) => [
                          styles.viewportPresetChip,
                          styles.viewportMenuPresetChip,
                          active && styles.viewportPresetChipActive,
                          pressed && styles.viewportPresetChipPressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.viewportPresetChipText,
                            active && styles.viewportPresetChipTextActive,
                          ]}
                        >
                          {preset.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    onPress={handleShowCustomViewportEditor}
                    style={({ pressed }) => [
                      styles.viewportPresetChip,
                      styles.viewportMenuPresetChip,
                      (showCustomViewportEditor || !desktopViewportMatchesPreset) &&
                        styles.viewportPresetChipActive,
                      pressed && styles.viewportPresetChipPressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.viewportPresetChipText,
                        (showCustomViewportEditor || !desktopViewportMatchesPreset) &&
                          styles.viewportPresetChipTextActive,
                      ]}
                    >
                      Custom
                    </Text>
                  </Pressable>
                </View>
                {showCustomViewportEditor ? (
                  <View style={styles.viewportInputRow}>
                    <View style={styles.viewportField}>
                      <Text style={styles.viewportFieldLabel}>W</Text>
                      <TextInput
                        value={desktopViewportDraft.width}
                        onChangeText={(value) =>
                          setDesktopViewportDraft((current) => ({ ...current, width: value }))
                        }
                        keyboardType="number-pad"
                        autoCorrect={false}
                        autoCapitalize="none"
                        style={styles.viewportFieldInput}
                        placeholder="1920"
                        placeholderTextColor={colors.textMuted}
                      />
                    </View>
                    <View style={styles.viewportField}>
                      <Text style={styles.viewportFieldLabel}>H</Text>
                      <TextInput
                        value={desktopViewportDraft.height}
                        onChangeText={(value) =>
                          setDesktopViewportDraft((current) => ({ ...current, height: value }))
                        }
                        keyboardType="number-pad"
                        autoCorrect={false}
                        autoCapitalize="none"
                        style={styles.viewportFieldInput}
                        placeholder="1080"
                        placeholderTextColor={colors.textMuted}
                      />
                    </View>
                    <Pressable
                      onPress={handleApplyDesktopViewport}
                      style={({ pressed }) => [
                        styles.viewportApplyButton,
                        pressed && styles.viewportApplyButtonPressed,
                      ]}
                    >
                      <Text style={styles.viewportApplyButtonText}>Apply</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={styles.viewportCurrentLabel}>
                    Current viewport: {desktopViewportLabel}
                  </Text>
                )}
              </Pressable>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>

        <View style={styles.contentArea}>
          {previewUrl ? (
            <View
              style={[
                styles.previewSurface,
                {
                  marginBottom: Platform.OS === 'web' ? bottomBarReservedSpace : 0,
                  backgroundColor: desktopModeEnabled ? '#000' : theme.colors.bgMain,
                },
              ]}
            >
              {Platform.OS === 'web' ? (
                desktopModeEnabled ? (
                  <ScrollView
                    horizontal
                    style={styles.previewViewport}
                    contentContainerStyle={styles.desktopScrollContent}
                    showsHorizontalScrollIndicator
                    bounces={false}
                    directionalLockEnabled
                    nestedScrollEnabled
                  >
                    {createElement('iframe', {
                      key: `${previewUrl}-${webReloadKey}-desktop`,
                      src: previewUrl,
                      title: pageTitle?.trim() || siteLabel,
                      style: iframeStyle,
                      onLoad: () => setLoadingPreview(false),
                    })}
                  </ScrollView>
                ) : (
                  <View style={styles.previewViewport}>
                    {createElement('iframe', {
                      key: `${previewUrl}-${webReloadKey}-mobile`,
                      src: previewUrl,
                      title: pageTitle?.trim() || siteLabel,
                      style: iframeStyle,
                      onLoad: () => setLoadingPreview(false),
                    })}
                  </View>
                )
              ) : desktopModeEnabled ? (
                <View
                  style={styles.previewViewport}
                  onLayout={handleNativePreviewViewportLayout}
                >
                  {nativeShellMode ? (
                    <View style={styles.previewViewport}>
                      <WebView
                        key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}`}
                        ref={webViewRef}
                        source={{ uri: previewUrl }}
                        originWhitelist={['*']}
                        javaScriptEnabled
                        domStorageEnabled
                        sharedCookiesEnabled
                        thirdPartyCookiesEnabled
                        allowsBackForwardNavigationGestures
                        startInLoadingState
                        setSupportMultipleWindows={false}
                        automaticallyAdjustContentInsets={false}
                        automaticallyAdjustsScrollIndicatorInsets={false}
                        contentInset={{
                          top: 0,
                          left: 0,
                          right: 0,
                          bottom: webViewBottomInset,
                        }}
                        contentInsetAdjustmentBehavior="never"
                        contentMode={nativeContentMode}
                        scalesPageToFit={false}
                        setBuiltInZoomControls
                        setDisplayZoomControls={false}
                        userAgent={nativeUserAgent}
                        onMessage={handleDesktopFrameMessage}
                        onNavigationStateChange={handleNavigationStateChange}
                        onShouldStartLoadWithRequest={handleShouldStartLoad}
                        onLoadStart={() => setLoadingPreview(true)}
                        onLoadEnd={() => setLoadingPreview(false)}
                        onContentProcessDidTerminate={handleContentProcessDidTerminate}
                        onError={(event) =>
                          setCapabilitiesError(
                            event.nativeEvent.description || 'Could not load preview.'
                          )
                        }
                        onHttpError={(event) =>
                          setCapabilitiesError(
                            `Preview returned HTTP ${String(event.nativeEvent.statusCode)}.`
                          )
                        }
                        style={styles.webView}
                      />
                    </View>
                  ) : (
                    <ScrollView
                      key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}-shell`}
                      ref={desktopScrollViewRef}
                      style={styles.previewViewport}
                      contentContainerStyle={styles.desktopNativeScrollContent}
                      horizontal
                      showsHorizontalScrollIndicator
                      showsVerticalScrollIndicator
                      bounces={false}
                      alwaysBounceHorizontal={false}
                      alwaysBounceVertical={false}
                      directionalLockEnabled={false}
                      pinchGestureEnabled={Platform.OS === 'ios'}
                      scrollEnabled
                      minimumZoomScale={desktopMinimumZoomScale}
                      maximumZoomScale={3}
                      bouncesZoom={false}
                    >
                      <View
                        style={[
                          styles.desktopNativeCanvas,
                          {
                            width: desktopViewportSize.width,
                            height: desktopCanvasHeight,
                          },
                        ]}
                      >
                        <WebView
                          key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}`}
                          ref={webViewRef}
                          source={{ uri: previewUrl }}
                          originWhitelist={['*']}
                          javaScriptEnabled
                          domStorageEnabled
                          sharedCookiesEnabled
                          thirdPartyCookiesEnabled
                          allowsBackForwardNavigationGestures
                          startInLoadingState
                          setSupportMultipleWindows={false}
                          automaticallyAdjustContentInsets={false}
                          automaticallyAdjustsScrollIndicatorInsets={false}
                          contentInset={{
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: webViewBottomInset,
                          }}
                          contentInsetAdjustmentBehavior="never"
                          injectedJavaScript={overviewInjectedJavaScript}
                          onMessage={handleOverviewMessage}
                          scrollEnabled={false}
                          contentMode={nativeContentMode}
                          scalesPageToFit
                          setBuiltInZoomControls
                          setDisplayZoomControls={false}
                          userAgent={nativeUserAgent}
                          onNavigationStateChange={handleNavigationStateChange}
                          onShouldStartLoadWithRequest={handleShouldStartLoad}
                          onLoadStart={() => setLoadingPreview(true)}
                          onLoadEnd={() => setLoadingPreview(false)}
                          onContentProcessDidTerminate={handleContentProcessDidTerminate}
                          onError={(event) =>
                            setCapabilitiesError(
                              event.nativeEvent.description || 'Could not load preview.'
                            )
                          }
                          onHttpError={(event) =>
                            setCapabilitiesError(
                              `Preview returned HTTP ${String(event.nativeEvent.statusCode)}.`
                            )
                          }
                          style={[
                            styles.desktopNativeWebView,
                            {
                              width: desktopViewportSize.width,
                              height: desktopCanvasHeight,
                            },
                          ]}
                        />
                      </View>
                    </ScrollView>
                  )}
                </View>
              ) : (
                <View style={styles.previewViewport}>
                  <WebView
                    key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}`}
                    ref={webViewRef}
                    source={{ uri: previewUrl }}
                    originWhitelist={['*']}
                    javaScriptEnabled
                    domStorageEnabled
                    sharedCookiesEnabled
                    thirdPartyCookiesEnabled
                    allowsBackForwardNavigationGestures
                    startInLoadingState
                    setSupportMultipleWindows={false}
                    automaticallyAdjustContentInsets={false}
                    automaticallyAdjustsScrollIndicatorInsets={false}
                    contentInset={{
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: webViewBottomInset,
                    }}
                    contentInsetAdjustmentBehavior="never"
                    contentMode={nativeContentMode}
                    scalesPageToFit
                    setBuiltInZoomControls
                    setDisplayZoomControls={false}
                    userAgent={nativeUserAgent}
                    onNavigationStateChange={handleNavigationStateChange}
                    onShouldStartLoadWithRequest={handleShouldStartLoad}
                    onLoadStart={() => setLoadingPreview(true)}
                    onLoadEnd={() => setLoadingPreview(false)}
                    onContentProcessDidTerminate={handleContentProcessDidTerminate}
                    onScroll={handleWebViewScroll}
                    onError={(event) =>
                      setCapabilitiesError(
                        event.nativeEvent.description || 'Could not load preview.'
                      )
                    }
                    onHttpError={(event) =>
                      setCapabilitiesError(
                        `Preview returned HTTP ${String(event.nativeEvent.statusCode)}.`
                      )
                    }
                    style={styles.webView}
                  />
                </View>
              )}
              {loadingPreview ||
              (desktopOverviewEnabled && !nativeOverviewShellEnabled && !overviewReady) ? (
                <View style={styles.loadingOverlay}>
                  <ActivityIndicator color={colors.textPrimary} />
                  <Text style={styles.loadingText}>Loading preview</Text>
                </View>
              ) : null}
            </View>
          ) : (
            <ScrollView
              style={styles.startPage}
              contentContainerStyle={[
                styles.startPageContent,
                { paddingBottom: bottomBarReservedSpace + theme.spacing.xl },
              ]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.startHero}>
                <View style={styles.startHeroIcon}>
                  <Ionicons name="globe-outline" size={20} color={colors.textPrimary} />
                </View>
                <Text style={styles.startHeroTitle}>Open a local preview</Text>
                <Text style={styles.startHeroSubtitle}>
                  Use the search bar above or tap a running localhost target.
                </Text>
              </View>

              <View style={styles.quickSection}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Running now</Text>
                  <Text style={styles.sectionSubtitle}>Detected local web servers.</Text>
                </View>
                {suggestionsLoading ? (
                  <View style={styles.loadingInline}>
                    <ActivityIndicator color={colors.textPrimary} />
                    <Text style={styles.loadingInlineText}>Scanning local web servers…</Text>
                  </View>
                ) : suggestions.length > 0 ? (
                  <View style={styles.tileGrid}>
                    {suggestions.map((suggestion, index) => (
                      <QuickTargetTile
                        key={`${suggestion.targetUrl}-${index}`}
                        icon="flash-outline"
                        title={getCompactBrowserLabel(suggestion.targetUrl)}
                        subtitle={suggestion.label}
                        onPress={() => void openPreview(suggestion.targetUrl)}
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.emptyStateText}>
                    No local web servers responded right now.
                  </Text>
                )}
              </View>

              <View style={styles.quickSection}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Recent</Text>
                  <Text style={styles.sectionSubtitle}>Fast re-open targets.</Text>
                </View>
                {recentTargetUrls.length > 0 ? (
                  <View style={styles.tileGrid}>
                    {recentTargetUrls.map((target, index) => (
                      <QuickTargetTile
                        key={`${target}-${index}`}
                        icon="time-outline"
                        title={getCompactBrowserLabel(target)}
                        subtitle={target}
                        onPress={() => void openPreview(target)}
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.emptyStateText}>
                    Open one preview and it will appear here.
                  </Text>
                )}
              </View>
            </ScrollView>
          )}
        </View>

        <RNAnimated.View
          style={[
            styles.bottomBarWrap,
            {
              paddingBottom: bottomBarInset,
              transform: [{ translateY: bottomBarTranslateY }],
            },
          ]}
        >
          <View style={styles.bottomBar}>
            <Pressable
              onPress={handleGoBackPress}
              disabled={Platform.OS === 'web' || !canGoBack}
              style={({ pressed }) => [
                styles.bottomNavButton,
                (Platform.OS === 'web' || !canGoBack) && styles.navButtonDisabled,
                pressed && Platform.OS !== 'web' && canGoBack && styles.iconButtonPressed,
              ]}
            >
              <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
            </Pressable>
            <Pressable
              onPress={handleGoForwardPress}
              disabled={Platform.OS === 'web' || !canGoForward}
              style={({ pressed }) => [
                styles.bottomNavButton,
                (Platform.OS === 'web' || !canGoForward) && styles.navButtonDisabled,
                pressed && Platform.OS !== 'web' && canGoForward && styles.iconButtonPressed,
              ]}
            >
              <Ionicons name="chevron-forward" size={22} color={colors.textPrimary} />
            </Pressable>
            <Pressable
              onPress={handleReload}
              style={({ pressed }) => [
                styles.bottomNavButton,
                styles.bottomNavButtonPrimary,
                pressed && styles.bottomNavButtonPrimaryPressed,
              ]}
            >
              <Ionicons
                name={loadingPreview ? 'hourglass-outline' : 'refresh-outline'}
                size={20}
                color={colors.textPrimary}
              />
            </Pressable>
            <Pressable
              onPress={previewUrl ? handleShowStartPage : () => void loadSuggestions()}
              style={({ pressed }) => [
                styles.bottomNavButton,
                pressed && styles.iconButtonPressed,
              ]}
            >
              <Ionicons
                name={previewUrl ? 'home-outline' : 'scan-outline'}
                size={20}
                color={colors.textPrimary}
              />
            </Pressable>
          </View>
        </RNAnimated.View>
      </SafeAreaView>
    </View>
  );
});

function StatusBanner({
  tone,
  message,
}: {
  tone: 'warning' | 'error';
  message: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const icon = tone === 'warning' ? 'warning-outline' : 'alert-circle-outline';
  const color = tone === 'warning' ? theme.colors.warning : theme.colors.error;

  return (
    <View
      style={[
        styles.statusBanner,
        tone === 'warning' ? styles.statusBannerWarning : styles.statusBannerError,
      ]}
    >
      <Ionicons name={icon} size={16} color={color} />
      <Text
        style={[
          styles.statusBannerText,
          tone === 'warning' ? styles.warningText : styles.errorText,
        ]}
      >
        {message}
      </Text>
    </View>
  );
}

function QuickTargetTile({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickTile,
        pressed && styles.quickTilePressed,
      ]}
    >
      <View style={styles.quickTileIcon}>
        <Ionicons name={icon} size={16} color={theme.colors.textPrimary} />
      </View>
      <Text style={styles.quickTileTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.quickTileSubtitle} numberOfLines={2}>
        {subtitle}
      </Text>
    </Pressable>
  );
}

function getCompactBrowserLabel(rawUrl: string | null | undefined): string {
  if (!rawUrl) {
    return 'Local preview';
  }

  try {
    const parsed = new URL(rawUrl);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return rawUrl.replace(/^https?:\/\//, '');
  }
}

function parseDesktopViewportValue(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 320 || value > 4096) {
    return null;
  }
  return value;
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    safeArea: {
      flex: 1,
    },
    chrome: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.sm,
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.transparent,
    },
    viewportTray: {
      paddingBottom: theme.spacing.sm,
      flexShrink: 0,
    },
    viewportModeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    viewportModeScroller: {
      flex: 1,
    },
    viewportPresetRow: {
      gap: theme.spacing.xs,
      paddingRight: theme.spacing.md,
      minHeight: 34,
      alignItems: 'center',
    },
    viewportPresetChip: {
      minHeight: 30,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      alignItems: 'center',
      justifyContent: 'center',
    },
    viewportPresetChipActive: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    viewportPresetChipPressed: {
      opacity: 0.86,
    },
    viewportPresetChipText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    viewportPresetChipTextActive: {
      color: theme.colors.textPrimary,
    },
    viewportSettingsButton: {
      minHeight: 30,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    viewportMenuBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.48)',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.md,
    },
    viewportMenuKeyboardLayer: {
      width: '100%',
    },
    viewportMenuCard: {
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    viewportMenuHeader: {
      gap: theme.spacing.xs,
    },
    viewportMenuTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    viewportMenuSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    viewportMenuPresetGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.xs,
    },
    viewportMenuPresetChip: {
      minWidth: 96,
    },
    viewportInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      flexWrap: 'wrap',
    },
    viewportField: {
      minWidth: 84,
      paddingHorizontal: theme.spacing.sm,
      minHeight: 36,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    viewportFieldLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontWeight: '700',
    },
    viewportFieldInput: {
      minWidth: 34,
      paddingVertical: 0,
      flex: 1,
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    viewportApplyButton: {
      minHeight: 36,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.accent,
    },
    viewportApplyButtonPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    viewportApplyButtonText: {
      ...theme.typography.caption,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
    viewportCurrentLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontWeight: '600',
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    chromeButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    omnibox: {
      flex: 1,
      minHeight: 42,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgInput,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    omniboxInput: {
      flex: 1,
      minWidth: 0,
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      paddingVertical: theme.spacing.sm,
    },
    omniboxIconButton: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    submitButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.accent,
    },
    submitButtonPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    submitButtonDisabled: {
      backgroundColor: theme.colors.bgItem,
    },
    navButtonDisabled: {
      opacity: 0.42,
    },
    iconButtonPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    statusBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
      marginHorizontal: theme.spacing.md,
      marginTop: theme.spacing.sm,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    statusBannerWarning: {
      backgroundColor: theme.colors.warningBg,
      borderColor: 'rgba(247, 210, 126, 0.22)',
    },
    statusBannerError: {
      backgroundColor: theme.colors.errorBg,
      borderColor: 'rgba(239, 68, 68, 0.28)',
    },
    statusBannerText: {
      ...theme.typography.caption,
      flex: 1,
      lineHeight: 18,
    },
    warningText: {
      color: theme.colors.warning,
    },
    errorText: {
      color: theme.colors.error,
    },
    contentArea: {
      flex: 1,
      minHeight: 0,
    },
    previewSurface: {
      flex: 1,
      minHeight: 0,
      marginHorizontal: 0,
      marginTop: 0,
      marginBottom: 0,
      borderRadius: 0,
      borderWidth: 0,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgMain,
    },
    previewViewport: {
      flex: 1,
      minHeight: 0,
      overflow: 'hidden',
    },
    desktopScrollContent: {
      flexGrow: 1,
      minHeight: '100%',
    },
    desktopNativeScrollContent: {
      flexGrow: 1,
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
    },
    desktopNativeCanvas: {
      alignSelf: 'flex-start',
      backgroundColor: theme.colors.bgMain,
      overflow: 'hidden',
    },
    desktopNativeWebView: {
      backgroundColor: theme.colors.bgMain,
    },
    webView: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    loadingOverlay: {
      position: 'absolute',
      top: theme.spacing.sm,
      right: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
    },
    loadingText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    startPage: {
      flex: 1,
    },
    startPageContent: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xxl,
      paddingBottom: theme.spacing.xxl,
      gap: theme.spacing.xl,
    },
    startHero: {
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.lg,
    },
    startHeroIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
    },
    startHeroTitle: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
      fontSize: 22,
    },
    startHeroSubtitle: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      maxWidth: 280,
    },
    quickSection: {
      gap: theme.spacing.md,
    },
    sectionHeader: {
      gap: 2,
      paddingHorizontal: theme.spacing.xs,
    },
    sectionTitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    sectionSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    loadingInline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xs,
    },
    loadingInlineText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    tileGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    quickTile: {
      flexBasis: '47%',
      flexGrow: 1,
      minHeight: 108,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    quickTilePressed: {
      backgroundColor: theme.colors.bgInput,
    },
    quickTileIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgItem,
    },
    quickTileTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    quickTileSubtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    emptyStateText: {
      ...theme.typography.body,
      color: theme.colors.textMuted,
      paddingHorizontal: theme.spacing.xs,
    },
    bottomBarWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xs,
      backgroundColor: theme.colors.transparent,
    },
    bottomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderRadius: 24,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    bottomNavButton: {
      width: 46,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bottomNavButtonActive: {
      backgroundColor: theme.colors.bgCanvasAccent,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    bottomNavButtonPrimary: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: theme.colors.bgItem,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    bottomNavButtonPrimaryPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
  });
