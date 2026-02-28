import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import { BrandMark } from '../components/BrandMark';
import { colors, radius, spacing, typography } from '../theme';

type OnboardingMode = 'initial' | 'edit';

interface OnboardingScreenProps {
  mode?: OnboardingMode;
  initialBridgeUrl?: string | null;
  allowInsecureRemoteBridge?: boolean;
  onSave: (bridgeUrl: string) => void;
  onCancel?: () => void;
}

type ConnectionCheck =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };
type OnboardingStep = 'intro' | 'connect';

const LOCAL_EXAMPLE_URL = 'http://192.168.1.20:8787';
const TAILSCALE_EXAMPLE_URL = 'http://100.101.102.103:8787';
const LOOPBACK_EXAMPLE_URL = 'http://127.0.0.1:8787';

export function OnboardingScreen({
  mode = 'initial',
  initialBridgeUrl,
  allowInsecureRemoteBridge = false,
  onSave,
  onCancel,
}: OnboardingScreenProps) {
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(
    mode === 'initial' ? 'intro' : 'connect'
  );
  const [urlInput, setUrlInput] = useState(initialBridgeUrl ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck>({ kind: 'idle' });

  useEffect(() => {
    setOnboardingStep(mode === 'initial' ? 'intro' : 'connect');
  }, [mode]);

  useEffect(() => {
    setUrlInput(initialBridgeUrl ?? '');
  }, [initialBridgeUrl]);

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

  const validateInput = useCallback((): string | null => {
    const normalized = normalizeBridgeUrlInput(urlInput);
    if (!normalized) {
      setFormError('Enter a valid URL. Example: http://100.101.102.103:8787');
      return null;
    }

    setFormError(null);
    return normalized;
  }, [urlInput]);

  const handleSave = useCallback(() => {
    const normalized = validateInput();
    if (!normalized) {
      return;
    }

    onSave(normalized);
  }, [onSave, validateInput]);

  const handleConnectionCheck = useCallback(async () => {
    const normalized = validateInput();
    if (!normalized) {
      setConnectionCheck({ kind: 'idle' });
      return;
    }

    setCheckingConnection(true);
    setConnectionCheck({ kind: 'idle' });

    try {
      const response = await fetch(toBridgeHealthUrl(normalized), { method: 'GET' });
      if (!response.ok) {
        throw new Error(`health returned ${response.status}`);
      }

      setConnectionCheck({
        kind: 'success',
        message: `Connected (${response.status})`,
      });
    } catch (error) {
      const message = (error as Error).message || 'request failed';
      setConnectionCheck({
        kind: 'error',
        message: `Could not reach bridge: ${message}`,
      });
    } finally {
      setCheckingConnection(false);
    }
  }, [validateInput]);

  const applyPreset = useCallback((value: string) => {
    setUrlInput(value);
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
  }, []);

  const goToConnectStep = useCallback(() => {
    setOnboardingStep('connect');
  }, []);

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
                    onSubmitEditing={handleSave}
                  />
                  <Text style={styles.helperText}>
                    Supports `http`, `https`, `ws`, and `wss`. `/rpc` is added automatically.
                  </Text>

                  <View style={styles.presetRow}>
                    <PresetChip label="LAN" onPress={() => applyPreset(LOCAL_EXAMPLE_URL)} />
                    <PresetChip label="Tailscale" onPress={() => applyPreset(TAILSCALE_EXAMPLE_URL)} />
                    <PresetChip label="Localhost" onPress={() => applyPreset(LOOPBACK_EXAMPLE_URL)} />
                  </View>

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
                      onPress={handleSave}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && styles.primaryButtonPressed,
                      ]}
                    >
                      <Ionicons name="arrow-forward" size={16} color={colors.black} />
                      <Text style={styles.primaryButtonText}>
                        {mode === 'edit' ? 'Save URL' : 'Continue'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.hintCard}>
                  <Text style={styles.hintTitle}>Quick Setup</Text>
                  <Text style={styles.hintText}>1. Start the bridge on your machine (port 8787 by default).</Text>
                  <Text style={styles.hintText}>2. Use your LAN or Tailscale IP in the URL above.</Text>
                  <Text style={styles.hintText}>3. Keep phone and host on the same private network.</Text>
                </View>
            </ScrollView>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function PresetChip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.presetChip, pressed && styles.presetChipPressed]}
    >
      <Text style={styles.presetChipText}>{label}</Text>
    </Pressable>
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
  helperText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  presetChip: {
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  presetChipPressed: {
    opacity: 0.78,
  },
  presetChipText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
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
  primaryButtonText: {
    ...typography.headline,
    color: colors.black,
    fontWeight: '700',
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
