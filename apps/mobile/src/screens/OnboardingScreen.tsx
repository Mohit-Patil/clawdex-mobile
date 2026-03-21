import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BlurView } from 'expo-blur';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
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
type IntroFeature = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
};

const BRIDGE_SETUP_COMMANDS = 'npm install -g clawdex-mobile@latest\nclawdex init';
const INTRO_FEATURES: IntroFeature[] = [
  {
    icon: 'pulse-outline',
    title: 'Start and monitor runs',
    description: 'Launch new Codex work from your phone and follow streaming updates as it runs.',
  },
  {
    icon: 'chatbubble-ellipses-outline',
    title: 'Resume threads',
    description: 'Pick up existing chats and keep active work moving without going back to desktop.',
  },
  {
    icon: 'shield-checkmark-outline',
    title: 'Review approvals',
    description: 'Handle clarification prompts and approve commands or file changes in-app.',
  },
  {
    icon: 'folder-open-outline',
    title: 'Browse workspaces',
    description: 'Open recent folders or navigate server directories before starting work.',
  },
  {
    icon: 'git-branch-outline',
    title: 'Git actions',
    description: 'Review diffs, commit, and push chat workspaces from the Git view.',
  },
  {
    icon: 'mic-outline',
    title: 'Voice, files, images',
    description: 'Use push-to-talk and attach workspace files or phone images to prompts.',
  },
];
const SETUP_STAGES = [
  {
    title: 'Start bridge',
    description: 'Run the CLI on your server and wait for the pairing QR.',
  },
  {
    title: 'Pair bridge',
    description: 'Scan QR or paste the bridge URL and token.',
  },
  {
    title: 'Verify auth',
    description: 'Confirm health and authenticated RPC before continuing.',
  },
] as const;

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

  const modeTitle = mode === 'edit' ? 'Update Bridge URL' : 'Pair Your Bridge';
  const modeDescription =
    mode === 'edit'
      ? 'Switch this phone to another bridge without rebuilding the app.'
      : 'Connect this phone to your private bridge and verify that it responds.';
  const normalizedTokenPreview = tokenInput.trim();
  const showOnboardingDock = mode === 'initial';
  const currentSetupStage = useMemo(() => {
    if (showIntroStep) {
      return 1;
    }
    if (connectionCheck.kind === 'success') {
      return 3;
    }
    if (normalizedBridgeUrl || normalizedTokenPreview) {
      return 2;
    }
    return 1;
  }, [connectionCheck.kind, normalizedBridgeUrl, normalizedTokenPreview, showIntroStep]);

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
    let healthCheckError: string | null = null;
    try {
      const headers: Record<string, string> | undefined = token
        ? { Authorization: `Bearer ${token}` }
        : undefined;
      const healthUrl = toBridgeHealthUrl(normalized);
      try {
        const response = await fetch(healthUrl, { method: 'GET', headers });
        if (response.status !== 200) {
          healthCheckError = `health returned ${response.status}`;
        }
      } catch (error) {
        healthCheckError = (error as Error).message || 'network request failed';
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
        message: healthCheckError
          ? 'Connected. Authenticated RPC verified; /health endpoint did not return 200.'
          : 'Connected. URL and token both verified.',
      });
      return true;
    } catch (error) {
      const baseMessage = (error as Error).message || 'request failed';
      const hint =
        Platform.OS === 'android' && baseMessage.includes('Network request failed')
          ? ' (If using Android emulator, use http://10.0.2.2:8787 for localhost bridge.)'
          : '';
      setConnectionCheck({
        kind: 'error',
        message: `Bridge verification failed: ${baseMessage}${hint}`,
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
      <LinearGradient
        colors={['#020304', '#05070C', '#0A0E16']}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={styles.ambientCanvas}>
        <LinearGradient
          colors={['rgba(181, 189, 204, 0.20)', 'rgba(181, 189, 204, 0.04)', 'transparent']}
          style={styles.ambientOrbPrimary}
        />
        <LinearGradient
          colors={['rgba(255, 255, 255, 0.10)', 'rgba(255, 255, 255, 0.02)', 'transparent']}
          style={styles.ambientOrbSecondary}
        />
      </View>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: 'padding', default: undefined })}
          style={styles.keyboardAvoiding}
        >
          {showIntroStep ? (
            <View style={styles.introRoot}>
              <View style={styles.introHeader}>
                <View style={styles.introBrandRow}>
                  <BrandMark size={24} />
                  <Text style={styles.introBrandName}>Clawdex</Text>
                </View>
                <AmbientBadge icon="lock-closed-outline" label="Private bridge" />
              </View>

              <ScrollView
                style={styles.introScroll}
                contentContainerStyle={styles.introScrollContent}
                showsVerticalScrollIndicator={false}
              >
                <LinearGradient
                  colors={[
                    'rgba(181, 189, 204, 0.22)',
                    'rgba(34, 39, 48, 0.75)',
                    'rgba(7, 9, 12, 0.96)',
                  ]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.introHero}
                >
                  <Text style={styles.introHeroEyebrow}>Mobile control surface</Text>
                  <Text style={styles.introHeroTitle}>Run Codex away from your desk.</Text>
                  <Text style={styles.introHeroDescription}>
                    Continue threads, review work, and approve changes from a paired private
                    bridge.
                  </Text>
                </LinearGradient>

                <View style={styles.introSectionHeader}>
                  <Text style={styles.introSectionTitle}>What you can do from mobile</Text>
                  <Text style={styles.introSectionSubtitle}>
                    The phone UI should feel like a control surface, not a read-only mirror.
                  </Text>
                </View>

                <View style={styles.introFeatureGrid}>
                  {INTRO_FEATURES.map((feature) => (
                    <IntroFeatureCard
                      key={feature.title}
                      icon={feature.icon}
                      title={feature.title}
                      description={feature.description}
                    />
                  ))}
                </View>

                <BlurView intensity={40} tint="dark" style={styles.introContextCard}>
                  <Text style={styles.introContextTitle}>Best on trusted networks</Text>
                  <Text style={styles.introContextText}>
                    Built for your own machine and private network paths. Pair over LAN nearby, or
                    use Tailscale when the bridge lives on another device.
                  </Text>
                  <View style={styles.introContextPillRow}>
                    <AmbientBadge icon="git-network-outline" label="Private network only" />
                    <AmbientBadge icon="shield-checkmark-outline" label="Token auth required" />
                  </View>
                </BlurView>
              </ScrollView>

              <View style={styles.introFooter}>
                {showOnboardingDock ? <OnboardingStepDock currentStage={currentSetupStage} /> : null}
                <Pressable
                  onPress={goToConnectStep}
                  style={({ pressed }) => [
                    styles.introNextButton,
                    pressed && styles.introNextButtonPressed,
                  ]}
                >
                  <Text style={styles.introNextButtonText}>Pair your bridge</Text>
                  <Ionicons name="arrow-forward" size={19} color={colors.black} />
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.connectRoot}>
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <LinearGradient
                  colors={[
                    'rgba(181, 189, 204, 0.18)',
                    'rgba(22, 25, 31, 0.82)',
                    'rgba(7, 9, 12, 0.98)',
                  ]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.connectHero}
                >
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
                  <Text style={styles.connectEyebrow}>Bridge pairing</Text>
                  <Text style={styles.heroTitle}>{modeTitle}</Text>
                  <Text style={styles.heroDescription}>{modeDescription}</Text>
                </LinearGradient>

                <BlurView intensity={55} tint="dark" style={styles.formCard}>
                  <View style={styles.commandPanel}>
                    <View style={styles.formSectionHeader}>
                      <Text style={styles.formSectionEyebrow}>1. Start the bridge</Text>
                      <Text style={styles.formSectionTitle}>
                        Run these on your server first. This installs the CLI, starts the bridge,
                        and prints the pairing QR used here.
                      </Text>
                    </View>
                    <CommandSnippet
                      label="Run on your server"
                      command={BRIDGE_SETUP_COMMANDS}
                      hint="After it starts, scan the pairing QR in this screen."
                    />
                  </View>

                  <View style={styles.formSectionHeader}>
                    <Text style={styles.formSectionEyebrow}>2. Pair the bridge</Text>
                    <Text style={styles.formSectionTitle}>
                      Scan the bridge QR first. If that is not available, enter the URL and token
                      manually.
                    </Text>
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
                    <Text style={styles.scanButtonText}>Scan bridge QR</Text>
                  </Pressable>
                  <Text style={styles.helperText}>
                    Recommended first. QR fills the bridge URL and token together.
                  </Text>

                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>Bridge URL</Text>
                    <View style={styles.inputRow}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="globe-outline" size={16} color={colors.textSecondary} />
                      </View>
                      <TextInput
                        value={urlInput}
                        onChangeText={(value) => {
                          setUrlInput(value);
                          setFormError(null);
                          setConnectionCheck({ kind: 'idle' });
                        }}
                        keyboardAppearance="dark"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        placeholder="http://100.101.102.103:8787"
                        placeholderTextColor={colors.textMuted}
                        style={styles.inputText}
                        returnKeyType="done"
                        onSubmitEditing={() => {
                          void handleSave();
                        }}
                      />
                    </View>
                  </View>

                  <View style={styles.fieldGroup}>
                    <View style={styles.tokenHeaderRow}>
                      <Text style={styles.label}>Bridge Token</Text>
                      <Text style={styles.optionalLabel}>Required</Text>
                    </View>
                    <View style={styles.tokenInputWrap}>
                      <View style={styles.inputRow}>
                        <View style={styles.inputIconWrap}>
                          <Ionicons name="key-outline" size={16} color={colors.textSecondary} />
                        </View>
                        <TextInput
                          value={tokenInput}
                          onChangeText={(value) => {
                            setTokenInput(value);
                            setConnectionCheck({ kind: 'idle' });
                          }}
                          keyboardAppearance="dark"
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="default"
                          placeholder="Paste bridge token"
                          placeholderTextColor={colors.textMuted}
                          style={styles.inputText}
                          secureTextEntry={tokenHidden}
                          returnKeyType="done"
                          onSubmitEditing={() => {
                            void handleSave();
                          }}
                        />
                      </View>
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
                  </View>

                  <Text style={styles.helperText}>
                    URL supports `http`, `https`, `ws`, and `wss`. `/rpc` is added automatically.
                  </Text>

                  {normalizedBridgeUrl ? (
                    <View style={styles.previewWrap}>
                      <Text style={styles.previewLabel}>Normalized target</Text>
                      <Text selectable style={styles.previewValue}>
                        {normalizedBridgeUrl}
                      </Text>
                    </View>
                  ) : null}

                  {insecureRemoteWarning ? (
                    <StatusBanner
                      tone="warning"
                      icon="warning-outline"
                      message={insecureRemoteWarning}
                    />
                  ) : null}

                  {formError ? (
                    <StatusBanner tone="error" icon="close-circle-outline" message={formError} />
                  ) : null}
                  {connectionCheck.kind === 'success' ? (
                    <StatusBanner
                      tone="success"
                      icon="checkmark-circle-outline"
                      message={connectionCheck.message}
                    />
                  ) : null}
                  {connectionCheck.kind === 'error' ? (
                    <StatusBanner
                      tone="error"
                      icon="alert-circle-outline"
                      message={connectionCheck.message}
                    />
                  ) : null}

                  <View style={styles.formSectionHeader}>
                    <Text style={styles.formSectionEyebrow}>3. Verify and continue</Text>
                    <Text style={styles.formSectionTitle}>
                      Confirm the bridge responds before saving it into the app.
                    </Text>
                  </View>

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
                </BlurView>
              </ScrollView>
              {showOnboardingDock ? (
                <View style={styles.connectFooter}>
                  <OnboardingStepDock currentStage={currentSetupStage} />
                </View>
              ) : null}
            </View>
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

function IntroFeatureCard({
  icon,
  title,
  description,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.introFeatureCard}>
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

function AmbientBadge({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  return (
    <View style={styles.ambientBadge}>
      <Ionicons name={icon} size={13} color={colors.textSecondary} />
      <Text style={styles.ambientBadgeText}>{label}</Text>
    </View>
  );
}

function OnboardingStepDock({ currentStage }: { currentStage: number }) {
  return (
    <BlurView intensity={45} tint="dark" style={styles.stepperDock}>
      <View style={styles.stepperDockRow}>
        {SETUP_STAGES.map((stage, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber === currentStage;
          const isComplete = stepNumber < currentStage;
          return (
            <View
              key={stage.title}
              style={[
                styles.stepperPill,
                isActive && styles.stepperPillActive,
                isComplete && styles.stepperPillComplete,
              ]}
            >
              <View
                style={[
                  styles.stepperPillIndex,
                  isActive && styles.stepperPillIndexActive,
                  isComplete && styles.stepperPillIndexComplete,
                ]}
              >
                <Text
                  style={[
                    styles.stepperPillIndexText,
                    (isActive || isComplete) && styles.stepperPillIndexTextActive,
                  ]}
                >
                  {isComplete ? '✓' : String(stepNumber)}
                </Text>
              </View>
              <Text
                numberOfLines={1}
                style={[
                  styles.stepperPillTitle,
                  isActive && styles.stepperPillTitleActive,
                  isComplete && styles.stepperPillTitleComplete,
                ]}
              >
                {stage.title}
              </Text>
            </View>
          );
        })}
      </View>
    </BlurView>
  );
}

function CommandSnippet({
  label,
  command,
  hint,
}: {
  label: string;
  command: string;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1400);
  }, [command]);

  return (
    <View style={styles.commandCard}>
      <View style={styles.commandCardHeader}>
        <View style={styles.commandCardHeaderLeft}>
          <Ionicons name="terminal-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.commandCardLabel}>{label}</Text>
        </View>
        <Pressable
          onPress={() => {
            void handleCopy();
          }}
          style={({ pressed }) => [
            styles.commandCopyButton,
            copied && styles.commandCopyButtonCopied,
            pressed && styles.commandCopyButtonPressed,
          ]}
        >
          <Ionicons
            name={copied ? 'checkmark-outline' : 'copy-outline'}
            size={14}
            color={copied ? colors.black : colors.textPrimary}
          />
          <Text
            style={[
              styles.commandCopyButtonText,
              copied && styles.commandCopyButtonTextCopied,
            ]}
          >
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      <View style={styles.commandCodeWrap}>
        <Text selectable style={styles.commandCodeText}>
          {command}
        </Text>
      </View>
      <Text style={styles.commandCardHint}>{hint}</Text>
    </View>
  );
}

function StatusBanner({
  tone,
  icon,
  message,
}: {
  tone: 'warning' | 'error' | 'success';
  icon: keyof typeof Ionicons.glyphMap;
  message: string;
}) {
  const iconColor =
    tone === 'warning' ? '#F7D27E' : tone === 'success' ? colors.statusComplete : colors.error;

  return (
    <View
      style={[
        styles.statusBanner,
        tone === 'warning'
          ? styles.statusBannerWarning
          : tone === 'success'
            ? styles.statusBannerSuccess
            : styles.statusBannerError,
      ]}
    >
      <Ionicons
        name={icon}
        size={16}
        color={iconColor}
      />
      <Text
        style={[
          styles.statusBannerText,
          tone === 'warning'
            ? styles.warningText
            : tone === 'success'
              ? styles.successText
              : styles.errorText,
        ]}
      >
        {message}
      </Text>
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
  ambientCanvas: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  ambientOrbPrimary: {
    position: 'absolute',
    top: -110,
    right: -70,
    width: 280,
    height: 280,
    borderRadius: 140,
  },
  ambientOrbSecondary: {
    position: 'absolute',
    bottom: 110,
    left: -90,
    width: 220,
    height: 220,
    borderRadius: 110,
  },
  introRoot: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  introHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  introBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  introBrandName: {
    ...typography.headline,
    color: colors.textPrimary,
    fontSize: 18,
    letterSpacing: -0.2,
  },
  introScroll: {
    flex: 1,
  },
  introScrollContent: {
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  introHero: {
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    padding: spacing.lg,
    gap: spacing.sm,
    overflow: 'hidden',
  },
  introHeroEyebrow: {
    ...typography.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  introHeroTitle: {
    ...typography.largeTitle,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.4,
  },
  introHeroDescription: {
    ...typography.body,
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  ambientBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
  },
  ambientBadgeText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  stepperDock: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(12, 14, 18, 0.76)',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    overflow: 'hidden',
  },
  stepperDockRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  stepperPill: {
    flex: 1,
    minHeight: 36,
    borderRadius: radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
  },
  stepperPillActive: {
    backgroundColor: 'rgba(181, 189, 204, 0.10)',
    borderColor: colors.borderHighlight,
  },
  stepperPillComplete: {
    backgroundColor: 'rgba(198, 205, 217, 0.08)',
    borderColor: 'rgba(198, 205, 217, 0.22)',
  },
  stepperPillIndex: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  stepperPillIndexActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  stepperPillIndexComplete: {
    backgroundColor: colors.statusComplete,
    borderColor: colors.statusComplete,
  },
  stepperPillIndexText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 10,
    lineHeight: 12,
  },
  stepperPillIndexTextActive: {
    color: colors.black,
  },
  stepperPillTitle: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: 10,
    lineHeight: 12,
  },
  stepperPillTitleActive: {
    color: colors.textPrimary,
  },
  stepperPillTitleComplete: {
    color: colors.textPrimary,
  },
  introSectionHeader: {
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  introSectionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
  },
  introSectionSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  introFeatureGrid: {
    gap: spacing.sm,
  },
  introFeatureCard: {
    flexDirection: 'row',
    gap: spacing.md,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(7, 9, 12, 0.72)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  introFeatureIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
  },
  introFeatureTextWrap: {
    flex: 1,
    gap: 2,
  },
  introFeatureTitle: {
    ...typography.headline,
    fontSize: 14,
  },
  introFeatureDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  introContextCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(12, 14, 18, 0.76)',
    padding: spacing.lg,
    gap: spacing.sm,
    overflow: 'hidden',
  },
  introContextTitle: {
    ...typography.headline,
  },
  introContextText: {
    ...typography.body,
    color: colors.textSecondary,
  },
  introContextPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  introFooter: {
    gap: spacing.sm,
  },
  introNextButton: {
    borderRadius: 18,
    backgroundColor: colors.accent,
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  introNextButtonPressed: {
    backgroundColor: colors.accentPressed,
  },
  introNextButtonText: {
    ...typography.headline,
    color: colors.black,
    fontSize: 17,
    fontWeight: '700',
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
  connectRoot: {
    flex: 1,
  },
  connectFooter: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  connectHero: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    padding: spacing.lg,
    gap: spacing.xs,
    overflow: 'hidden',
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
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
  connectEyebrow: {
    ...typography.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  heroTitle: {
    ...typography.largeTitle,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: -0.45,
  },
  heroDescription: {
    ...typography.body,
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  formCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(12, 14, 18, 0.76)',
    padding: spacing.lg,
    gap: spacing.md,
    overflow: 'hidden',
  },
  formSectionHeader: {
    gap: spacing.xs,
  },
  formSectionEyebrow: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.85,
  },
  formSectionTitle: {
    ...typography.headline,
    fontSize: 15,
    lineHeight: 21,
  },
  modeCardGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  modePresetCard: {
    flex: 1,
    minHeight: 146,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: spacing.md,
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  modePresetCardSelected: {
    backgroundColor: 'rgba(181, 189, 204, 0.10)',
    borderColor: colors.borderHighlight,
  },
  modePresetCardPressed: {
    opacity: 0.84,
  },
  modePresetIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
  },
  modePresetIconWrapSelected: {
    backgroundColor: 'rgba(181, 189, 204, 0.16)',
    borderColor: colors.borderHighlight,
  },
  modePresetTitle: {
    ...typography.headline,
    fontSize: 15,
  },
  modePresetDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  helperText: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 18,
  },
  commandPanel: {
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  commandCard: {
    gap: spacing.xs,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: spacing.md,
  },
  commandCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  commandCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  commandCardLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  commandCopyButton: {
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    flexShrink: 0,
  },
  commandCopyButtonCopied: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  commandCopyButtonPressed: {
    opacity: 0.84,
  },
  commandCopyButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  commandCopyButtonTextCopied: {
    color: colors.black,
  },
  commandCodeWrap: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  commandCodeText: {
    ...typography.mono,
    color: colors.textPrimary,
    fontSize: 12,
    lineHeight: 18,
  },
  commandCardHint: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 16,
  },
  fieldGroup: {
    gap: spacing.sm,
  },
  label: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.85,
    color: colors.textMuted,
  },
  tokenHeaderRow: {
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
  inputRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)',
    minHeight: 54,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  inputIconWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputText: {
    flex: 1,
    minWidth: 0,
    ...typography.body,
    color: colors.textPrimary,
    paddingVertical: spacing.md,
  },
  tokenInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minWidth: 0,
  },
  tokenRevealBtn: {
    minWidth: 74,
    minHeight: 54,
    flexShrink: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    paddingHorizontal: spacing.sm,
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
  scanButton: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    minHeight: 50,
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
    ...typography.headline,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  previewWrap: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.03)',
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
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  statusBannerWarning: {
    backgroundColor: 'rgba(247, 210, 126, 0.08)',
    borderColor: 'rgba(247, 210, 126, 0.22)',
  },
  statusBannerSuccess: {
    backgroundColor: 'rgba(198, 205, 217, 0.10)',
    borderColor: 'rgba(198, 205, 217, 0.22)',
  },
  statusBannerError: {
    backgroundColor: colors.errorBg,
    borderColor: 'rgba(239, 68, 68, 0.28)',
  },
  statusBannerText: {
    flex: 1,
    ...typography.caption,
    lineHeight: 18,
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
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    borderRadius: 16,
    minHeight: 54,
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
    borderRadius: 16,
    minHeight: 54,
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
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: '#07090C',
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
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
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
});
