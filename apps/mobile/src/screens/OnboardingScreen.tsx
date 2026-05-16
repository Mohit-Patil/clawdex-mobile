import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BlurView } from 'expo-blur';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
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
import { ChoiceAction } from '../components/ChoiceAction';
import { useAppTheme, type AppTheme } from '../theme';
import codexMarkPng from '../../assets/brand/engine-codex.png';
import cursorMarkPng from '../../assets/brand/engine-cursor.png';
import opencodeMarkPng from '../../assets/brand/engine-opencode.png';

export type OnboardingMode = 'initial' | 'edit' | 'add' | 'reconnect';

export interface OnboardingBridgeProfileDraft {
  bridgeUrl: string;
  bridgeToken: string | null;
}

interface OnboardingScreenProps {
  mode?: OnboardingMode;
  initialBridgeUrl?: string | null;
  initialBridgeToken?: string | null;
  allowInsecureRemoteBridge?: boolean;
  allowQueryTokenAuth?: boolean;
  onSave: (draft: OnboardingBridgeProfileDraft) => void | Promise<void>;
  onCancel?: () => void;
}

type ConnectionCheck =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };
type OnboardingStep = 'intro' | 'connect';
type PairingPayload = { bridgeToken: string; bridgeUrl?: string };

const BRIDGE_SETUP_COMMANDS = 'npm install -g clawdex-mobile@latest\nclawdex init';
const CLAWDEX_BRIDGE_SETUP_URL = 'https://getclawdex.com/bridge-setup/';
const SETUP_STAGES = [
  {
    title: 'Start',
  },
  {
    title: 'Pair',
  },
  {
    title: 'Verify',
  },
] as const;
const INTRO_ENGINE_MARKS = [
  { label: 'Codex', logo: codexMarkPng },
  { label: 'Cursor', logo: cursorMarkPng },
  { label: 'OpenCode', logo: opencodeMarkPng },
] as const;
const INTRO_ENGINE_ROTATION_MS = 1450;
const INTRO_ENGINE_FADE_MS = 120;
const CONNECTION_CHECK_TIMEOUT_MS = 7_000;

export function OnboardingScreen({
  mode = 'initial',
  initialBridgeUrl,
  initialBridgeToken,
  allowInsecureRemoteBridge = false,
  allowQueryTokenAuth = false,
  onSave,
  onCancel,
}: OnboardingScreenProps) {
  const theme = useAppTheme();
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
  const [introEngineIndex, setIntroEngineIndex] = useState(0);
  const introHeroMotion = useRef(new Animated.Value(mode === 'initial' ? 0 : 1)).current;
  const introActionsMotion = useRef(new Animated.Value(mode === 'initial' ? 0 : 1)).current;
  const introEngineMotion = useRef(new Animated.Value(1)).current;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const onboardingBackgroundGradient = theme.isDark
    ? (['#020304', '#05070C', '#0A0E16'] as const)
    : (['#EEF3F8', '#E3EBF3', '#D8E2EC'] as const);
  const ambientPrimaryGradient = theme.isDark
    ? (['rgba(181, 189, 204, 0.20)', 'rgba(181, 189, 204, 0.04)', 'transparent'] as const)
    : (['rgba(56, 79, 106, 0.16)', 'rgba(56, 79, 106, 0.04)', 'transparent'] as const);
  const ambientSecondaryGradient = theme.isDark
    ? (['rgba(255, 255, 255, 0.10)', 'rgba(255, 255, 255, 0.02)', 'transparent'] as const)
    : (['rgba(255, 255, 255, 0.42)', 'rgba(255, 255, 255, 0.10)', 'transparent'] as const);

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

  useEffect(() => {
    if (!showIntroStep) {
      introHeroMotion.setValue(1);
      introActionsMotion.setValue(1);
      return;
    }

    introHeroMotion.setValue(0);
    introActionsMotion.setValue(0);
    Animated.sequence([
      Animated.timing(introHeroMotion, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(introActionsMotion, {
        toValue: 1,
        duration: 340,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [introActionsMotion, introHeroMotion, showIntroStep]);

  const introHeroAnimatedStyle = useMemo(
    () => ({
      opacity: introHeroMotion,
      transform: [
        {
          translateY: introHeroMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [26, 0],
          }),
        },
        {
          scale: introHeroMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [0.98, 1],
          }),
        },
      ],
    }),
    [introHeroMotion]
  );
  const introActionsAnimatedStyle = useMemo(
    () => ({
      opacity: introActionsMotion,
      transform: [
        {
          translateY: introActionsMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [18, 0],
          }),
        },
      ],
    }),
    [introActionsMotion]
  );
  const introEngineAnimatedStyle = useMemo(
    () => ({
      opacity: introEngineMotion,
      transform: [
        {
          translateY: introEngineMotion.interpolate({
            inputRange: [0, 1],
            outputRange: [6, 0],
          }),
        },
      ],
    }),
    [introEngineMotion]
  );

  useEffect(() => {
    if (!showIntroStep) {
      introEngineMotion.stopAnimation();
      introEngineMotion.setValue(1);
      setIntroEngineIndex(0);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => {
      timer = setTimeout(() => {
        Animated.timing(introEngineMotion, {
          toValue: 0,
          duration: INTRO_ENGINE_FADE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (!active || !finished) {
            return;
          }
          setIntroEngineIndex((previous) => (previous + 1) % INTRO_ENGINE_MARKS.length);
          Animated.timing(introEngineMotion, {
            toValue: 1,
            duration: INTRO_ENGINE_FADE_MS + 60,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start(({ finished: fadeInFinished }) => {
            if (active && fadeInFinished) {
              scheduleNext();
            }
          });
        });
      }, INTRO_ENGINE_ROTATION_MS);
    };

    introEngineMotion.setValue(1);
    scheduleNext();

    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
      introEngineMotion.stopAnimation();
    };
  }, [introEngineMotion, showIntroStep]);

  const introEngineMark = INTRO_ENGINE_MARKS[introEngineIndex];
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

  const normalizedTokenPreview = tokenInput.trim();
  const showOnboardingDock = mode === 'initial';
  const continueLabel =
    mode === 'edit' ? 'Save URL' : mode === 'reconnect' ? 'Reconnect' : 'Continue';
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
      setFormError('Connection token is required.');
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
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const abortController =
        typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutMessage = 'connection timed out after 7 seconds';
      const disconnectProbe = () => {
        const client: HostBridgeWsClient | null = probeClient;
        client?.disconnect();
      };

      try {
        const probe = async (): Promise<string | null> => {
          let healthCheckError: string | null = null;
          const headers: Record<string, string> | undefined = token
            ? { Authorization: `Bearer ${token}` }
            : undefined;
          const healthUrl = toBridgeHealthUrl(normalized);
          try {
            const response = await fetch(healthUrl, {
              method: 'GET',
              headers,
              signal: abortController?.signal,
            });
            if (response.status !== 200) {
              healthCheckError = `health returned ${response.status}`;
            }
          } catch (error) {
            if (timedOut) {
              throw new Error(timeoutMessage);
            }
            healthCheckError = (error as Error).message || 'network request failed';
          }

          if (timedOut) {
            throw new Error(timeoutMessage);
          }

          probeClient = new HostBridgeWsClient(normalized, {
            authToken: token,
            allowQueryTokenAuth,
            requestTimeoutMs: CONNECTION_CHECK_TIMEOUT_MS,
          });
          const rpcHealth = await probeClient.request<{ status?: string }>('bridge/health/read');
          if (rpcHealth?.status !== 'ok') {
            throw new Error('authenticated RPC probe returned unexpected response');
          }
          return healthCheckError;
        };

        const healthCheckError = await Promise.race([
          probe(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              abortController?.abort();
              disconnectProbe();
              reject(new Error(timeoutMessage));
            }, CONNECTION_CHECK_TIMEOUT_MS);
          }),
        ]);

        setConnectionCheck({
          kind: 'success',
          message: healthCheckError
            ? 'Connected. Authenticated RPC verified; /health endpoint did not return 200.'
            : 'Connected. URL and token both verified.',
        });
        return true;
      } catch {
        setConnectionCheck({
          kind: 'error',
          message: 'Connection error. Check the URL and token, then try again.',
        });
        return false;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        disconnectProbe();
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

    try {
      await onSave({
        bridgeUrl: validated.bridgeUrl,
        bridgeToken: normalizedToken,
      });
    } catch (error) {
      setConnectionCheck({
        kind: 'error',
        message: (error as Error).message || 'Saving the connection failed.',
      });
    }
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

  const goBackToIntro = useCallback(() => {
    setOnboardingStep('intro');
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
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
        setFormError('Camera permission is required to scan the pairing QR.');
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
        colors={onboardingBackgroundGradient}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={styles.ambientCanvas}>
        <LinearGradient
          colors={ambientPrimaryGradient}
          style={styles.ambientOrbPrimary}
        />
        <LinearGradient
          colors={ambientSecondaryGradient}
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
              </View>

              <View style={styles.introBody}>
                <Animated.View style={introHeroAnimatedStyle}>
                  <View style={styles.introHero}>
                    <View style={styles.introHeroArt}>
                      <View
                        style={styles.introHeroEngineCloud}
                        accessibilityLabel="Codex, Cursor, and OpenCode"
                      >
                        <View style={[styles.introHeroEngineCard, styles.introHeroEngineCardCodex]}>
                          <Image
                            source={codexMarkPng}
                            resizeMode="contain"
                            style={styles.introHeroEngineCardLogo}
                          />
                        </View>
                        <View style={[styles.introHeroEngineCard, styles.introHeroEngineCardCursor]}>
                          <Image
                            source={cursorMarkPng}
                            resizeMode="contain"
                            style={styles.introHeroEngineCardLogo}
                          />
                        </View>
                        <View
                          style={[styles.introHeroEngineCard, styles.introHeroEngineCardOpenCode]}
                        >
                          <Image
                            source={opencodeMarkPng}
                            resizeMode="contain"
                            style={[
                              styles.introHeroEngineCardLogo,
                              styles.introHeroEngineCardLogoWide,
                            ]}
                          />
                        </View>
                      </View>
                    </View>
                    <View style={styles.introHeroTitleWrap}>
                      <Animated.View
                        style={[styles.introHeroEngineWord, introEngineAnimatedStyle]}
                      >
                        <Text
                          style={styles.introHeroEngineLabel}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                        >
                          {introEngineMark.label}
                        </Text>
                      </Animated.View>
                      <Text
                        style={styles.introHeroTitleTail}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                      >
                        on your phone
                      </Text>
                    </View>
                    <Text style={styles.introHeroDescription}>
                      Pair your phone with your own machine.
                    </Text>
                  </View>
                </Animated.View>
              </View>

              <Animated.View style={[styles.introFooter, introActionsAnimatedStyle]}>
                <ChoiceAction
                  variant="primary"
                  logo="clawdex"
                  title="Private connection"
                  meta="Your machine"
                  onPress={goToConnectStep}
                />
              </Animated.View>
            </View>
          ) : (
            <View style={styles.connectRoot}>
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {showOnboardingDock ? <OnboardingStepDock currentStage={currentSetupStage} /> : null}
                <View style={styles.connectHeaderRow}>
                  <View style={styles.heroTopRowLeft}>
                    {showOnboardingDock ? (
                      <Pressable
                        onPress={goBackToIntro}
                        hitSlop={8}
                        style={({ pressed }) => [
                          styles.connectTopButton,
                          pressed && styles.cancelBtnPressed,
                        ]}
                      >
                        <Ionicons name="chevron-back" size={15} color={theme.colors.textPrimary} />
                        <Text style={styles.connectTopButtonText}>Back</Text>
                      </Pressable>
                    ) : (
                      <View style={styles.heroIconWrap}>
                        <Ionicons
                          name="hardware-chip-outline"
                          size={20}
                          color={theme.colors.textPrimary}
                        />
                      </View>
                    )}
                  </View>
                  <View style={styles.heroTopRowRight}>
                    {(mode === 'edit' || mode === 'add' || mode === 'reconnect') && onCancel ? (
                      <Pressable
                        onPress={onCancel}
                        hitSlop={8}
                        style={({ pressed }) => [styles.cancelBtn, pressed && styles.cancelBtnPressed]}
                      >
                        <Ionicons name="close" size={16} color={theme.colors.textPrimary} />
                      </Pressable>
                    ) : null}
                  </View>
                </View>

                <BlurView intensity={55} tint={theme.blurTint} style={styles.formCard}>
                  <View style={styles.commandPanel}>
                    <Text style={styles.formSectionEyebrow}>1. Start</Text>
                    <CommandSnippet
                      label="Desktop command"
                      command={BRIDGE_SETUP_COMMANDS}
                    />
                  </View>

                  <View style={styles.formSectionHeader}>
                    <Text style={styles.formSectionEyebrow}>2. Pair</Text>
                    <Text style={styles.formSectionTitle}>Scan QR or paste details.</Text>
                  </View>

                  <View style={styles.connectPrimaryActions}>
                    <Pressable
                      onPress={() => {
                        void openScanner();
                      }}
                      style={({ pressed }) => [
                        styles.scanButton,
                        styles.connectActionPrimary,
                        pressed && styles.scanButtonPressed,
                      ]}
                    >
                      <Ionicons name="qr-code-outline" size={16} color={theme.colors.textPrimary} />
                      <Text style={styles.scanButtonText}>Scan QR</Text>
                    </Pressable>
                  </View>

                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>URL</Text>
                    <View style={styles.inputRow}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="globe-outline" size={16} color={theme.colors.textSecondary} />
                      </View>
                      <TextInput
                        value={urlInput}
                        onChangeText={(value) => {
                          setUrlInput(value);
                          setFormError(null);
                          setConnectionCheck({ kind: 'idle' });
                        }}
                        keyboardAppearance={theme.keyboardAppearance}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        placeholder="http://100.101.102.103:8787"
                        placeholderTextColor={theme.colors.textMuted}
                        style={styles.inputText}
                        returnKeyType="done"
                        onSubmitEditing={() => {
                          void handleSave();
                        }}
                      />
                    </View>
                  </View>

                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>Token</Text>
                    <View style={styles.tokenInputWrap}>
                      <View style={styles.inputRow}>
                        <View style={styles.inputIconWrap}>
                          <Ionicons name="key-outline" size={16} color={theme.colors.textSecondary} />
                        </View>
                        <TextInput
                          value={tokenInput}
                          onChangeText={(value) => {
                            setTokenInput(value);
                            setConnectionCheck({ kind: 'idle' });
                          }}
                          keyboardAppearance={theme.keyboardAppearance}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="default"
                          placeholder="Paste connection token"
                          placeholderTextColor={theme.colors.textMuted}
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
                          color={theme.colors.textSecondary}
                        />
                        <Text style={styles.tokenRevealBtnText}>
                          {tokenHidden ? 'Show' : 'Hide'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>

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
                    <Text style={styles.formSectionEyebrow}>3. Save</Text>
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
                        <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                      ) : (
                        <Ionicons name="pulse-outline" size={16} color={theme.colors.textPrimary} />
                      )}
                      <Text style={styles.secondaryButtonText}>Test Connection</Text>
                    </Pressable>
                  </View>
                </BlurView>
              </ScrollView>
              <View style={styles.connectFooter}>
                <Pressable
                  onPress={() => {
                    void handleSave();
                  }}
                  disabled={checkingConnection}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    styles.connectFooterButton,
                    pressed && !checkingConnection && styles.primaryButtonPressed,
                    checkingConnection && styles.primaryButtonDisabled,
                  ]}
                >
                  {checkingConnection ? (
                    <View style={styles.primaryButtonIconWrap}>
                      <ActivityIndicator size="small" color={theme.colors.accentText} />
                    </View>
                  ) : (
                    <View style={styles.primaryButtonIconWrap}>
                      <Ionicons
                        name="shield-checkmark-outline"
                        size={18}
                        color={theme.colors.accentText}
                      />
                    </View>
                  )}
                  <View style={styles.primaryButtonContent}>
                    <View style={styles.primaryButtonCopy}>
                      <Text style={styles.primaryButtonText}>{continueLabel}</Text>
                      <Text style={styles.primaryButtonSubtext}>Start using Clawdex</Text>
                    </View>
                    <Ionicons name="arrow-forward" size={20} color={theme.colors.accentText} />
                  </View>
                </Pressable>
              </View>
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
                  <Text style={styles.scannerTitle}>Scan Pairing QR</Text>
                  <Pressable
                    onPress={closeScanner}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.scannerCloseBtn,
                      pressed && styles.scannerCloseBtnPressed,
                    ]}
                  >
                    <Ionicons name="close" size={18} color={theme.colors.textPrimary} />
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
                        Camera permission is required to scan the pairing QR.
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.scannerHintText}>
                  Scan the pairing QR to fill the URL and token.
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

function OnboardingStepDock({ currentStage }: { currentStage: number }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <BlurView intensity={45} tint={theme.blurTint} style={styles.stepperDock}>
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
}: {
  label: string;
  command: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1400);
  }, [command]);
  const handleShareGuide = useCallback(() => {
    const title = 'Clawdex bridge setup';
    void Share.share(
      Platform.OS === 'ios'
        ? { title, url: CLAWDEX_BRIDGE_SETUP_URL }
        : { title, message: `${title}\n${CLAWDEX_BRIDGE_SETUP_URL}` }
    ).catch(() => {});
  }, []);

  return (
    <View style={styles.commandCard}>
      <View style={styles.commandCardHeader}>
        <View style={styles.commandCardHeaderLeft}>
          <Ionicons name="terminal-outline" size={14} color={theme.colors.textSecondary} />
          <Text style={styles.commandCardLabel}>{label}</Text>
        </View>
        <View style={styles.commandCardActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share bridge setup guide"
            onPress={handleShareGuide}
            style={({ pressed }) => [
              styles.commandIconButton,
              pressed && styles.commandCopyButtonPressed,
            ]}
          >
            <Ionicons name="share-outline" size={14} color={theme.colors.textPrimary} />
          </Pressable>
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
              color={copied ? theme.colors.accentText : theme.colors.textPrimary}
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
      </View>
      <View style={styles.commandCodeWrap}>
        <Text selectable style={styles.commandCodeText}>
          {command}
        </Text>
      </View>
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
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const iconColor =
    tone === 'warning' ? '#F7D27E' : tone === 'success' ? theme.colors.statusComplete : theme.colors.error;

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

const createStyles = (theme: AppTheme) => {
  const glassDockBackground = theme.isDark ? 'rgba(12, 14, 18, 0.76)' : 'rgba(246, 249, 252, 0.90)';
  const glassSubtleBackground = theme.isDark ? 'rgba(255,255,255,0.03)' : theme.colors.bgInput;
  const glassFeatureBackground = theme.isDark ? 'rgba(7, 9, 12, 0.72)' : 'rgba(243, 247, 251, 0.88)';
  const glassFeatureIcon = theme.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.84)';
  const glassSelectedBackground = theme.isDark ? 'rgba(181, 189, 204, 0.10)' : 'rgba(56, 79, 106, 0.12)';
  const glassSelectedStrong = theme.isDark ? 'rgba(181, 189, 204, 0.16)' : 'rgba(56, 79, 106, 0.18)';
  const scannerSheetBackground = theme.isDark ? '#07090C' : theme.colors.bgElevated;

  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgMain,
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
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.xxl,
    gap: theme.spacing.md,
    justifyContent: 'space-between',
  },
  introHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  introBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  introBrandName: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 18,
    letterSpacing: 0,
  },
  introBody: {
    flex: 1,
    justifyContent: 'center',
  },
  introHero: {
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
  },
  introHeroArt: {
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  introHeroEngineCloud: {
    width: 236,
    height: 158,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  introHeroEngineCard: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.76)',
    boxShadow: theme.isDark
      ? '0px 12px 24px rgba(0, 0, 0, 0.22)'
      : '0px 10px 20px rgba(15, 31, 54, 0.10)',
  },
  introHeroEngineCardCodex: {
    top: 4,
    left: 82,
    width: 72,
    height: 72,
    borderRadius: 24,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.isDark ? 'rgba(181, 189, 204, 0.16)' : 'rgba(255,255,255,0.86)',
  },
  introHeroEngineCardCursor: {
    left: 24,
    top: 82,
    width: 66,
    height: 66,
    borderRadius: 22,
    borderColor: theme.isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15, 23, 42, 0.16)',
    backgroundColor: theme.isDark ? 'rgba(15, 23, 42, 0.96)' : '#111827',
    transform: [{ rotate: '-8deg' }],
  },
  introHeroEngineCardOpenCode: {
    right: 12,
    top: 88,
    width: 94,
    height: 58,
    borderRadius: 20,
    transform: [{ rotate: '7deg' }],
  },
  introHeroEngineCardLogo: {
    width: 38,
    height: 38,
  },
  introHeroEngineCardLogoWide: {
    width: 64,
    height: 36,
  },
  introHeroTitleWrap: {
    width: '100%',
    maxWidth: 340,
    minHeight: 82,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  introHeroEngineWord: {
    minWidth: 160,
    maxWidth: 260,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  introHeroEngineLabel: {
    ...theme.typography.largeTitle,
    flexShrink: 1,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: 0,
    textAlign: 'center',
    color: theme.colors.textPrimary,
  },
  introHeroTitleTail: {
    ...theme.typography.largeTitle,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: 0,
    textAlign: 'center',
    color: theme.colors.textPrimary,
  },
  introHeroDescription: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 280,
  },
  stepperDock: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: glassDockBackground,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    overflow: 'hidden',
  },
  stepperDockRow: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  stepperPill: {
    flex: 1,
    minHeight: 36,
    borderRadius: theme.radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
    gap: 6,
    backgroundColor: glassSubtleBackground,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
  },
  stepperPillActive: {
    backgroundColor: glassSelectedBackground,
    borderColor: theme.colors.borderHighlight,
  },
  stepperPillComplete: {
    backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(14, 159, 110, 0.10)',
    borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.22)' : 'rgba(14, 159, 110, 0.22)',
  },
  stepperPillIndex: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  stepperPillIndexActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  stepperPillIndexComplete: {
    backgroundColor: theme.colors.statusComplete,
    borderColor: theme.colors.statusComplete,
  },
  stepperPillIndexText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 10,
    lineHeight: 12,
  },
  stepperPillIndexTextActive: {
    color: theme.colors.accentText,
  },
  stepperPillTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '600',
    fontSize: 10,
    lineHeight: 12,
  },
  stepperPillTitleActive: {
    color: theme.colors.textPrimary,
  },
  stepperPillTitleComplete: {
    color: theme.colors.textPrimary,
  },
  introSectionHeader: {
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.xs,
  },
  introSectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  introSectionSubtitle: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
  },
  introFeatureGrid: {
    gap: theme.spacing.sm,
  },
  introFeatureCard: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: glassFeatureBackground,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  introFeatureIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: glassFeatureIcon,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
  },
  introFeatureTextWrap: {
    flex: 1,
    gap: 2,
  },
  introFeatureTitle: {
    ...theme.typography.headline,
    fontSize: 14,
  },
  introFeatureDescription: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },
  introContextCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: glassDockBackground,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
    overflow: 'hidden',
  },
  introContextTitle: {
    ...theme.typography.headline,
  },
  introContextText: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
  },
  introContextPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  introFooter: {
    gap: theme.spacing.sm,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  connectRoot: {
    flex: 1,
  },
  connectFooter: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xxl,
  },
  connectHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  heroTopRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  heroTopRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
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
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgMain,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnPressed: {
    opacity: 0.75,
  },
  connectTopButton: {
    minHeight: 32,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.66)',
    paddingHorizontal: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  connectTopButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  formCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: glassDockBackground,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    overflow: 'hidden',
  },
  connectPrimaryActions: {
    gap: theme.spacing.sm,
  },
  connectActionPrimary: {
    minHeight: 48,
  },
  formSectionHeader: {
    gap: theme.spacing.xs,
  },
  formSectionEyebrow: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  formSectionTitle: {
    ...theme.typography.headline,
    fontSize: 15,
    lineHeight: 21,
  },
  modeCardGrid: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  modePresetCard: {
    flex: 1,
    minHeight: 146,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: glassSubtleBackground,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
    justifyContent: 'space-between',
  },
  modePresetCardSelected: {
    backgroundColor: glassSelectedBackground,
    borderColor: theme.colors.borderHighlight,
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
    backgroundColor: theme.colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
  },
  modePresetIconWrapSelected: {
    backgroundColor: glassSelectedStrong,
    borderColor: theme.colors.borderHighlight,
  },
  modePresetTitle: {
    ...theme.typography.headline,
    fontSize: 15,
  },
  modePresetDescription: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },
  commandPanel: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
  },
  commandCard: {
    gap: theme.spacing.xs,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: glassSubtleBackground,
    padding: theme.spacing.md,
  },
  commandCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  commandCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  commandCardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    flexShrink: 0,
  },
  commandCardLabel: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '600',
    letterSpacing: 0,
  },
  commandCopyButton: {
    minHeight: 30,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgInput,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    flexShrink: 0,
  },
  commandCopyButtonCopied: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  commandCopyButtonPressed: {
    opacity: 0.84,
  },
  commandIconButton: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgInput,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commandCopyButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  commandCopyButtonTextCopied: {
    color: theme.colors.accentText,
  },
  commandCodeWrap: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgInput,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  commandCodeText: {
    ...theme.typography.mono,
    color: theme.colors.textPrimary,
    fontSize: 12,
    lineHeight: 18,
  },
  fieldGroup: {
    gap: theme.spacing.sm,
  },
  label: {
    ...theme.typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0,
    color: theme.colors.textMuted,
  },
  inputRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 16,
    backgroundColor: glassSubtleBackground,
    minHeight: 54,
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  inputIconWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputText: {
    flex: 1,
    minWidth: 0,
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    paddingVertical: theme.spacing.md,
  },
  tokenInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    minWidth: 0,
  },
  tokenRevealBtn: {
    minWidth: 74,
    minHeight: 54,
    flexShrink: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgInput,
    paddingHorizontal: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  tokenRevealBtnPressed: {
    opacity: 0.8,
  },
  tokenRevealBtnText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  scanButton: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgInput,
    minHeight: 50,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  scanButtonPressed: {
    opacity: 0.82,
  },
  scanButtonText: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  statusBannerWarning: {
    backgroundColor: theme.isDark ? 'rgba(247, 210, 126, 0.08)' : 'rgba(197, 106, 18, 0.12)',
    borderColor: 'rgba(247, 210, 126, 0.22)',
  },
  statusBannerSuccess: {
    backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.10)' : 'rgba(14, 159, 110, 0.10)',
    borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.22)' : 'rgba(14, 159, 110, 0.24)',
  },
  statusBannerError: {
    backgroundColor: theme.colors.errorBg,
    borderColor: 'rgba(239, 68, 68, 0.28)',
  },
  statusBannerText: {
    flex: 1,
    ...theme.typography.caption,
    lineHeight: 18,
  },
  warningText: {
    ...theme.typography.caption,
    color: theme.colors.warning,
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  successText: {
    ...theme.typography.caption,
    color: theme.colors.statusComplete,
  },
  actionRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    gap: theme.spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgInput,
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
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    gap: theme.spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    borderRadius: 16,
    minHeight: 54,
  },
  connectFooterButton: {
    flex: 0,
    minHeight: 78,
    borderRadius: 24,
    justifyContent: 'flex-start',
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.md,
  },
  primaryButtonPressed: {
    backgroundColor: theme.colors.accentPressed,
  },
  primaryButtonDisabled: {
    opacity: 0.72,
  },
  primaryButtonText: {
    ...theme.typography.headline,
    color: theme.colors.accentText,
    fontWeight: '700',
  },
  primaryButtonIconWrap: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.isDark ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.38)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.isDark ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.48)',
  },
  primaryButtonContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  primaryButtonCopy: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    gap: 2,
  },
  primaryButtonSubtext: {
    ...theme.typography.caption,
    color: theme.colors.accentText,
    opacity: 0.72,
    fontWeight: '600',
  },
  scannerModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  scannerSheet: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: scannerSheetBackground,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scannerTitle: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
  },
  scannerCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgMain,
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
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
  },
  scannerCamera: {
    flex: 1,
  },
  scannerPermissionWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  scannerPermissionText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  scannerHintText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  });
};
