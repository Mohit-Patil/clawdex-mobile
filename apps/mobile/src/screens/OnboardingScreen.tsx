import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  isInsecureRemoteUrl,
  normalizeBridgeUrlInput,
  toBridgeHealthUrl,
} from '../bridgeUrl';
import { HostBridgeWsClient } from '../api/ws';
import { BrandMark } from '../components/BrandMark';
import { colors, radius, spacing, typography } from '../theme';

type OnboardingMode = 'initial' | 'edit';

interface OnboardingScreenProps {
  mode?: OnboardingMode;
  initialBridgeUrl?: string | null;
  initialBridgeToken?: string | null;
  allowInsecureRemoteBridge?: boolean;
  allowQueryTokenAuth?: boolean;
  onSave: (bridgeUrl: string, bridgeToken: string | null) => void;
  onCancel?: () => void;
}

type ConnectionCheck =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };
type OnboardingStep = 'intro' | 'connect';
type PairingPayload = { bridgeToken: string; bridgeUrl?: string };
type BridgeModePreset = 'local' | 'tailscale';

const LOCAL_EXAMPLE_URL = 'http://192.168.1.20:8787';
const TAILSCALE_EXAMPLE_URL = 'http://100.101.102.103:8787';

export function OnboardingScreen({
  mode = 'initial',
  initialBridgeUrl,
  initialBridgeToken,
  allowInsecureRemoteBridge = false,
  allowQueryTokenAuth = false,
  onSave,
  onCancel,
}: OnboardingScreenProps) {
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(
    mode === 'initial' ? 'intro' : 'connect'
  );
  const [urlInput, setUrlInput] = useState(initialBridgeUrl ?? '');
  const [tokenInput, setTokenInput] = useState(initialBridgeToken ?? '');
  const [tokenHidden, setTokenHidden] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck>({ kind: 'idle' });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [scannerLocked, setScannerLocked] = useState(false);

  useEffect(() => {
    setOnboardingStep(mode === 'initial' ? 'intro' : 'connect');
  }, [mode]);

  useEffect(() => {
    setUrlInput(initialBridgeUrl ?? '');
  }, [initialBridgeUrl]);

  useEffect(() => {
    setTokenInput(initialBridgeToken ?? '');
  }, [initialBridgeToken]);

  const showIntroStep = mode === 'initial' && onboardingStep === 'intro';

  const normalizedBridgeUrl = useMemo(
    () => normalizeBridgeUrlInput(urlInput),
    [urlInput]
  );
  const insecureRemoteWarning = useMemo(() => {
    if (!normalizedBridgeUrl || allowInsecureRemoteBridge) {
      return null;
    }

    return isInsecureRemoteUrl(normalizedBridgeUrl)
      ? 'This is plain HTTP over a non-private host. Use HTTPS/WSS when crossing untrusted networks.'
      : null;
  }, [allowInsecureRemoteBridge, normalizedBridgeUrl]);

  const modeTitle = mode === 'edit' ? 'Update Bridge URL' : 'Connect Your Bridge';
  const modeDescription =
    mode === 'edit'
      ? 'Switch to another host bridge without rebuilding the app.'
      : 'Set the host bridge URL once, then use Codex from LAN, VPN, or Tailscale.';

  const validateInput = useCallback((): { bridgeUrl: string; bridgeToken: string } | null => {
    const normalized = normalizeBridgeUrlInput(urlInput);
    if (!normalized) {
      setFormError('Enter a valid URL. Example: http://100.101.102.103:8787');
      return null;
    }

    const normalizedToken = tokenInput.trim();
    if (!normalizedToken) {
      setFormError('Bridge token is required.');
      return null;
    }

    setFormError(null);
    return { bridgeUrl: normalized, bridgeToken: normalizedToken };
  }, [tokenInput, urlInput]);

  const normalizeTokenInput = useCallback((value: string): string | null => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, []);

  const runConnectionCheck = useCallback(
    async (normalized: string, token: string | null): Promise<boolean> => {
    setCheckingConnection(true);
    setConnectionCheck({ kind: 'idle' });

    let probeClient: HostBridgeWsClient | null = null;
    try {
      const headers: Record<string, string> | undefined = token
        ? { Authorization: `Bearer ${token}` }
        : undefined;
      const response = await fetch(toBridgeHealthUrl(normalized), { method: 'GET', headers });
      if (response.status !== 200) {
        throw new Error(`health returned ${response.status}`);
      }

      probeClient = new HostBridgeWsClient(normalized, {
        authToken: token,
        allowQueryTokenAuth,
        requestTimeoutMs: 10_000,
      });
      const rpcHealth = await probeClient.request<{ status?: string }>('bridge/health/read');
      if (rpcHealth?.status !== 'ok') {
        throw new Error('authenticated RPC probe returned unexpected response');
      }

      setConnectionCheck({
        kind: 'success',
        message: 'Connected. URL and token both verified.',
      });
      return true;
    } catch (error) {
      const message = (error as Error).message || 'request failed';
      setConnectionCheck({
        kind: 'error',
        message: `Bridge verification failed: ${message}`,
      });
      return false;
    } finally {
      probeClient?.disconnect();
      setCheckingConnection(false);
    }
    },
    [allowQueryTokenAuth]
  );

  const handleSave = useCallback(async () => {
    const validated = validateInput();
    if (!validated) {
      return;
    }

    const normalizedToken = normalizeTokenInput(validated.bridgeToken);
    const ok = await runConnectionCheck(validated.bridgeUrl, normalizedToken);
    if (!ok) {
      return;
    }

    onSave(validated.bridgeUrl, normalizedToken);
  }, [normalizeTokenInput, onSave, runConnectionCheck, validateInput]);

  const handleConnectionCheck = useCallback(async () => {
    const validated = validateInput();
    if (!validated) {
      setConnectionCheck({ kind: 'idle' });
      return;
    }

    const normalizedToken = normalizeTokenInput(validated.bridgeToken);
    await runConnectionCheck(validated.bridgeUrl, normalizedToken);
  }, [normalizeTokenInput, runConnectionCheck, validateInput]);

  const applyPreset = useCallback((value: string) => {
    setUrlInput(value);
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
  }, []);

  const applyModePreset = useCallback((preset: BridgeModePreset) => {
    applyPreset(preset === 'local' ? LOCAL_EXAMPLE_URL : TAILSCALE_EXAMPLE_URL);
  }, [applyPreset]);

  const goToConnectStep = useCallback(() => {
    setOnboardingStep('connect');
  }, []);

  const closeScanner = useCallback(() => {
    setScannerVisible(false);
    setScannerLocked(false);
    setScannerError(null);
  }, []);

  const openScanner = useCallback(async () => {
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
    setScannerError(null);

    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        setFormError('Camera permission is required to scan bridge QR.');
        return;
      }
    }

    setScannerLocked(false);
    setScannerVisible(true);
  }, [cameraPermission?.granted, requestCameraPermission]);

  const applyPairingPayload = useCallback((pairing: PairingPayload) => {
    if (pairing.bridgeUrl) {
      setUrlInput(pairing.bridgeUrl);
    }
    setTokenInput(pairing.bridgeToken);
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
    setScannerError(null);
    setScannerLocked(false);
    setScannerVisible(false);
  }, []);

  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);
      const pairing = parsePairingPayload(result.data);
      if (!pairing) {
        setScannerError('QR code is not a valid Clawdex bridge pairing code.');
        setTimeout(() => {
          setScannerLocked(false);
        }, 1200);
        return;
      }

      applyPairingPayload(pairing);
    },
    [applyPairingPayload, scannerLocked]
  );

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: 'padding', default: undefined })}
          style={styles.keyboardAvoiding}
        >
          {showIntroStep ? (
            <View style={styles.introRoot}>
              <View style={styles.introBrandRow}>
                <BrandMark size={24} />
                <Text style={styles.introBrandName}>Clawdex</Text>
              </View>
              <View style={styles.introMain}>
                <View style={styles.heroCard}>
                  <View style={styles.heroTopRow}>
                    <View style={styles.heroIconWrap}>
                      <Ionicons name="phone-portrait-outline" size={20} color={colors.textPrimary} />
                    </View>
                  </View>
                  <Text style={styles.heroTitle}>Codex on mobile</Text>
                  <Text style={styles.heroDescription}>
                    Run your host-side Codex workflows from your phone across LAN, VPN, or Tailscale.
                  </Text>
                </View>

                <View style={[styles.formCard, styles.introFeaturesCard]}>
                  <ScrollView
                    style={styles.introFeaturesList}
                    contentContainerStyle={styles.introFeaturesListContent}
                    showsVerticalScrollIndicator
                  >
                    <Text style={styles.introSectionTitle}>What You Can Do</Text>
                    <IntroFeatureRow
                      icon="chatbubble-ellipses-outline"
                      title="Continue threads"
                      description="Follow active chats and start new runs from your phone."
                    />
                    <IntroFeatureRow
                      icon="pulse-outline"
                      title="Track run progress"
                      description="See live status and streaming updates as Codex works."
                    />
                    <IntroFeatureRow
                      icon="git-branch-outline"
                      title="Handle git tasks"
                      description="Review status, diffs, and commits for chat workspaces."
                    />
                    <IntroFeatureRow
                      icon="mic-outline"
                      title="Talk to Codex"
                      description="Use voice input to speak your prompts directly from mobile."
                    />
                    <IntroFeatureRow
                      icon="attach-outline"
                      title="Share files and images"
                      description="Attach workspace files and phone media to your prompts."
                    />
                    <IntroFeatureRow
                      icon="shield-checkmark-outline"
                      title="Approve actions"
                      description="Review and approve command and file changes in-app."
                    />
                  </ScrollView>
                </View>
              </View>
              <View style={styles.introFooter}>
                <Pressable
                  onPress={goToConnectStep}
                  style={({ pressed }) => [
                    styles.introNextButton,
                    pressed && styles.introNextButtonPressed,
                  ]}
                >
                  <Text style={styles.introNextButtonText}>Next</Text>
                  <Ionicons name="arrow-forward" size={19} color={colors.black} />
                </Pressable>
              </View>
            </View>
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
            >
                <View style={styles.heroCard}>
                  <View style={styles.heroTopRow}>
                    <View style={styles.heroIconWrap}>
                      <Ionicons name="hardware-chip-outline" size={20} color={colors.textPrimary} />
                    </View>
                    {mode === 'edit' && onCancel ? (
                      <Pressable
                        onPress={onCancel}
                        hitSlop={8}
                        style={({ pressed }) => [styles.cancelBtn, pressed && styles.cancelBtnPressed]}
                      >
                        <Ionicons name="close" size={16} color={colors.textPrimary} />
                      </Pressable>
                    ) : null}
                  </View>
                  <Text style={styles.heroTitle}>{modeTitle}</Text>
                  <Text style={styles.heroDescription}>{modeDescription}</Text>
                </View>

                <View style={styles.formCard}>
                  <Text style={styles.label}>Bridge Mode</Text>
                  <View style={styles.modeRow}>
                    <Pressable
                      onPress={() => applyModePreset('local')}
                      style={({ pressed }) => [
                        styles.modeButton,
                        pressed && styles.modeButtonPressed,
                      ]}
                    >
                      <Ionicons name="wifi-outline" size={16} color={colors.textPrimary} />
                      <Text style={styles.modeButtonText}>Local (LAN)</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => applyModePreset('tailscale')}
                      style={({ pressed }) => [
                        styles.modeButton,
                        pressed && styles.modeButtonPressed,
                      ]}
                    >
                      <Ionicons name="shield-outline" size={16} color={colors.textPrimary} />
                      <Text style={styles.modeButtonText}>Tailscale</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.helperText}>
                    Pick the same mode used while starting the bridge, then adjust the IP if needed.
                  </Text>

                  <Text style={styles.label}>Bridge URL</Text>
                  <TextInput
                    value={urlInput}
                    onChangeText={(value) => {
                      setUrlInput(value);
                      setFormError(null);
                      setConnectionCheck({ kind: 'idle' });
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="http://100.101.102.103:8787"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      void handleSave();
                    }}
                  />
                  <View style={styles.tokenHeaderRow}>
                    <Text style={styles.label}>Bridge Token</Text>
                    <Text style={styles.optionalLabel}>Required</Text>
                  </View>
                  <View style={styles.tokenInputWrap}>
                    <TextInput
                      value={tokenInput}
                      onChangeText={(value) => {
                        setTokenInput(value);
                        setConnectionCheck({ kind: 'idle' });
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="default"
                      placeholder="Paste bridge token"
                      placeholderTextColor={colors.textMuted}
                      style={[styles.input, styles.tokenInput]}
                      secureTextEntry={tokenHidden}
                      returnKeyType="done"
                      onSubmitEditing={() => {
                        void handleSave();
                      }}
                    />
                    <Pressable
                      onPress={() => setTokenHidden((prev) => !prev)}
                      style={({ pressed }) => [
                        styles.tokenRevealBtn,
                        pressed && styles.tokenRevealBtnPressed,
                      ]}
                    >
                      <Ionicons
                        name={tokenHidden ? 'eye-outline' : 'eye-off-outline'}
                        size={16}
                        color={colors.textSecondary}
                      />
                      <Text style={styles.tokenRevealBtnText}>
                        {tokenHidden ? 'Show' : 'Hide'}
                      </Text>
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={() => {
                      void openScanner();
                    }}
                    style={({ pressed }) => [
                      styles.scanButton,
                      pressed && styles.scanButtonPressed,
                    ]}
                  >
                    <Ionicons name="qr-code-outline" size={16} color={colors.textPrimary} />
                    <Text style={styles.scanButtonText}>Scan Bridge QR</Text>
                  </Pressable>
                  <Text style={styles.helperText}>
                    URL supports `http`, `https`, `ws`, and `wss`. `/rpc` is added automatically.
                  </Text>

                  {normalizedBridgeUrl ? (
                    <View style={styles.previewWrap}>
                      <Text style={styles.previewLabel}>Normalized URL</Text>
                      <Text selectable style={styles.previewValue}>
                        {normalizedBridgeUrl}
                      </Text>
                    </View>
                  ) : null}

                  {insecureRemoteWarning ? (
                    <Text style={styles.warningText}>{insecureRemoteWarning}</Text>
                  ) : null}

                  {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
                  {connectionCheck.kind === 'success' ? (
                    <Text style={styles.successText}>{connectionCheck.message}</Text>
                  ) : null}
                  {connectionCheck.kind === 'error' ? (
                    <Text style={styles.errorText}>{connectionCheck.message}</Text>
                  ) : null}

                  <View style={styles.actionRow}>
                    <Pressable
                      onPress={() => {
                        void handleConnectionCheck();
                      }}
                      disabled={checkingConnection}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && !checkingConnection && styles.secondaryButtonPressed,
                        checkingConnection && styles.secondaryButtonDisabled,
                      ]}
                    >
                      {checkingConnection ? (
                        <ActivityIndicator size="small" color={colors.textPrimary} />
                      ) : (
                        <Ionicons name="pulse-outline" size={16} color={colors.textPrimary} />
                      )}
                      <Text style={styles.secondaryButtonText}>Test Connection</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void handleSave();
                      }}
                      disabled={checkingConnection}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && !checkingConnection && styles.primaryButtonPressed,
                        checkingConnection && styles.primaryButtonDisabled,
                      ]}
                    >
                      {checkingConnection ? (
                        <ActivityIndicator size="small" color={colors.black} />
                      ) : (
                        <Ionicons name="arrow-forward" size={16} color={colors.black} />
                      )}
                      <Text style={styles.primaryButtonText}>
                        {mode === 'edit' ? 'Save URL' : 'Continue'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.hintCard}>
                  <Text style={styles.hintTitle}>Quick Setup</Text>
                  <Text style={styles.hintText}>1. Start the bridge in Local (LAN) or Tailscale mode.</Text>
                  <Text style={styles.hintText}>2. Pick Local or Tailscale above, then confirm bridge URL.</Text>
                  <Text style={styles.hintText}>3. Scan bridge QR, then test connection and continue.</Text>
                </View>
            </ScrollView>
          )}
          <Modal
            animationType="slide"
            visible={scannerVisible}
            transparent
            onRequestClose={closeScanner}
          >
            <View style={styles.scannerModalRoot}>
              <View style={styles.scannerSheet}>
                <View style={styles.scannerHeader}>
                  <Text style={styles.scannerTitle}>Scan Bridge QR</Text>
                  <Pressable
                    onPress={closeScanner}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.scannerCloseBtn,
                      pressed && styles.scannerCloseBtnPressed,
                    ]}
                  >
                    <Ionicons name="close" size={18} color={colors.textPrimary} />
                  </Pressable>
                </View>
                <View style={styles.scannerCameraFrame}>
                  {cameraPermission?.granted ? (
                    <CameraView
                      style={styles.scannerCamera}
                      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                      onBarcodeScanned={scannerLocked ? undefined : handleBarcodeScanned}
                    />
                  ) : (
                    <View style={styles.scannerPermissionWrap}>
                      <Text style={styles.scannerPermissionText}>
                        Camera permission is required to scan bridge QR.
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.scannerHintText}>
                  Scan the bridge QR to autofill URL and token (or token-only fallback).
                </Text>
                {scannerError ? <Text style={styles.errorText}>{scannerError}</Text> : null}
              </View>
            </View>
          </Modal>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function IntroFeatureRow({
  icon,
  title,
  description,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.introFeatureRow}>
      <View style={styles.introFeatureIconWrap}>
        <Ionicons name={icon} size={16} color={colors.textPrimary} />
      </View>
      <View style={styles.introFeatureTextWrap}>
        <Text style={styles.introFeatureTitle}>{title}</Text>
        <Text style={styles.introFeatureDescription}>{description}</Text>
      </View>
    </View>
  );
}

function parsePairingPayload(rawValue: string): PairingPayload | null {
  const raw = rawValue.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      bridgeUrl?: unknown;
      url?: unknown;
      bridgeToken?: unknown;
      token?: unknown;
    };
    const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : '';
    const bridgeUrlRaw =
      typeof parsed.bridgeUrl === 'string'
        ? parsed.bridgeUrl
        : typeof parsed.url === 'string'
          ? parsed.url
          : '';
    const bridgeTokenRaw =
      typeof parsed.bridgeToken === 'string'
        ? parsed.bridgeToken
        : typeof parsed.token === 'string'
          ? parsed.token
          : '';
    const bridgeUrl = normalizeBridgeUrlInput(bridgeUrlRaw) ?? undefined;
    const bridgeToken = bridgeTokenRaw.trim();
    if (
      bridgeToken &&
      (
        type === 'clawdex-bridge-pair' ||
        type === 'clawdex/bridge-pair' ||
        type === 'clawdex-bridge-token' ||
        type === 'clawdex/bridge-token' ||
        !type
      )
    ) {
      return bridgeUrl ? { bridgeToken, bridgeUrl } : { bridgeToken };
    }
  } catch {
    // Try URI form fallback below.
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'clawdex:') {
      return null;
    }
    const bridgeUrl =
      normalizeBridgeUrlInput(
        parsed.searchParams.get('bridgeUrl') ?? parsed.searchParams.get('url') ?? ''
      ) ?? undefined;
    const bridgeToken = (
      parsed.searchParams.get('bridgeToken') ?? parsed.searchParams.get('token') ?? ''
    ).trim();
    if (!bridgeToken) {
      return null;
    }
    return bridgeUrl ? { bridgeToken, bridgeUrl } : { bridgeToken };
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgMain,
  },
  safeArea: {
    flex: 1,
  },
  keyboardAvoiding: {
    flex: 1,
  },
  introRoot: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  introBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  introBrandName: {
    ...typography.headline,
    color: colors.textPrimary,
    fontSize: 18,
    letterSpacing: -0.2,
  },
  introMain: {
    flex: 1,
    gap: spacing.md,
  },
  introFeaturesCard: {
    flex: 1,
    paddingVertical: spacing.md,
  },
  introFeaturesList: {
    flex: 1,
  },
  introFeaturesListContent: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  introFooter: {
    paddingTop: spacing.sm,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  heroCard: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.black,
    padding: spacing.lg,
    gap: spacing.sm,
    overflow: 'hidden',
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgMain,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnPressed: {
    opacity: 0.75,
  },
  heroTitle: {
    ...typography.largeTitle,
    fontSize: 28,
    letterSpacing: -0.5,
  },
  heroDescription: {
    ...typography.body,
    color: colors.textSecondary,
  },
  introSectionTitle: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
    color: colors.textMuted,
  },
  introFeatureRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.black,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 62,
  },
  introFeatureIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginTop: 2,
  },
  introFeatureTextWrap: {
    flex: 1,
    gap: 2,
  },
  introFeatureTitle: {
    ...typography.headline,
    color: colors.textPrimary,
    fontSize: 14,
  },
  introFeatureDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  introNextButton: {
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    width: '100%',
  },
  introNextButtonPressed: {
    backgroundColor: colors.accentPressed,
  },
  introNextButtonText: {
    ...typography.headline,
    color: colors.black,
    fontSize: 18,
    fontWeight: '700',
  },
  formCard: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.black,
    padding: spacing.lg,
    gap: spacing.sm,
    overflow: 'hidden',
  },
  label: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
    color: colors.textMuted,
  },
  tokenHeaderRow: {
    marginTop: spacing.xs,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  optionalLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
  },
  tokenInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  input: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.black,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  tokenInput: {
    flex: 1,
  },
  tokenRevealBtn: {
    minWidth: 74,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  tokenRevealBtnPressed: {
    opacity: 0.8,
  },
  tokenRevealBtnText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  modeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  modeButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  modeButtonPressed: {
    opacity: 0.82,
  },
  modeButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  scanButton: {
    marginTop: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  scanButtonPressed: {
    opacity: 0.82,
  },
  scanButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  helperText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  previewWrap: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.black,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  previewLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  previewValue: {
    ...typography.mono,
    color: colors.textPrimary,
    fontSize: 13,
  },
  warningText: {
    ...typography.caption,
    color: '#F7D27E',
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
  },
  successText: {
    ...typography.caption,
    color: colors.statusComplete,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  secondaryButtonPressed: {
    opacity: 0.8,
  },
  secondaryButtonDisabled: {
    opacity: 0.65,
  },
  secondaryButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  primaryButtonPressed: {
    backgroundColor: colors.accentPressed,
  },
  primaryButtonDisabled: {
    opacity: 0.72,
  },
  primaryButtonText: {
    ...typography.headline,
    color: colors.black,
    fontWeight: '700',
  },
  scannerModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  scannerSheet: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.black,
    padding: spacing.lg,
    gap: spacing.md,
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scannerTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  scannerCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgMain,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerCloseBtnPressed: {
    opacity: 0.75,
  },
  scannerCameraFrame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgMain,
  },
  scannerCamera: {
    flex: 1,
  },
  scannerPermissionWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  scannerPermissionText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  scannerHintText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  hintCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.black,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  hintTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  hintText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
