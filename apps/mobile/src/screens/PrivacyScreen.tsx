import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme, type AppTheme } from '../theme';

interface PrivacyScreenProps {
  policyUrl: string | null;
  onOpenDrawer: () => void;
}

export function PrivacyScreen({ policyUrl, onOpenDrawer }: PrivacyScreenProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [openingPolicy, setOpeningPolicy] = useState(false);

  const openPolicy = useCallback(async () => {
    if (!policyUrl || openingPolicy) {
      return;
    }

    try {
      setOpeningPolicy(true);
      const supported = await Linking.canOpenURL(policyUrl);
      if (!supported) {
        Alert.alert('Cannot open link', 'The privacy policy URL is not supported on this device.');
        return;
      }
      await Linking.openURL(policyUrl);
    } catch {
      Alert.alert('Could not open link', 'Please open the policy URL manually.');
    } finally {
      setOpeningPolicy(false);
    }
  }, [openingPolicy, policyUrl]);

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[colors.bgMain, colors.bgMain, colors.bgMain]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safeArea}>
        <BlurView intensity={80} tint={theme.blurTint} style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <Ionicons name="shield-checkmark" size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>Privacy</Text>
        </BlurView>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Section title="What This App Does">
            Clawdex Mobile connects to your own host bridge service and lets you view chats,
            run approved commands, and perform Git operations on your machine.
          </Section>

          <Section title="Data Processed">
            - Chat messages and responses are sent between mobile and your bridge.
            - Terminal command text and output are sent to the bridge when you run commands.
            - Git status, diffs, and commit messages are returned from your repo.
          </Section>

          <Section title="Data Storage and Retention">
            - Data is stored by services you run (Codex app-server cache, repo files, and logs).
            - This app does not define automatic cloud retention.
            - You control deletion by removing local bridge/cache/repo data.
          </Section>

          <Section title="Sharing">
            - No ad SDKs are used in this app.
            - Data may be sent to model providers only when you run assistant workflows through your setup.
            - You are responsible for configuring and securing your bridge host and network.
          </Section>

          <Section title="Security Controls">
            - Bridge token auth is enabled by default.
            - Terminal execution can be disabled or allowlisted server-side.
            - The bridge can be restricted to localhost and explicit CORS origins.
          </Section>

          <Text style={styles.sectionLabel}>Official Policy</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Text style={styles.cardTitle}>Privacy policy URL</Text>
            <Text selectable style={styles.policyUrl}>
              {policyUrl ?? 'Not configured. Set EXPO_PUBLIC_PRIVACY_POLICY_URL.'}
            </Text>
            <Pressable
              disabled={!policyUrl || openingPolicy}
              onPress={() => void openPolicy()}
              style={({ pressed }) => [
                styles.openBtn,
                (!policyUrl || openingPolicy) && styles.openBtnDisabled,
                pressed && policyUrl && !openingPolicy && styles.openBtnPressed
              ]}
            >
              <Ionicons name="open-outline" size={16} color={colors.white} />
              <Text style={styles.openBtnText}>
                {openingPolicy ? 'Opening...' : 'Open privacy policy'}
              </Text>
            </Pressable>
          </BlurView>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <>
      <Text style={styles.sectionLabel}>{title}</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <Text style={styles.bodyText}>{children}</Text>
      </BlurView>
    </>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.bgMain },
    safeArea: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderHighlight,
    },
    menuBtn: { padding: theme.spacing.xs },
    headerTitle: { ...theme.typography.headline, color: theme.colors.textPrimary },
    body: { flex: 1 },
    bodyContent: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl },
    sectionLabel: {
      ...theme.typography.caption,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.xs,
    },
    card: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    bodyText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
    },
    cardTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    policyUrl: {
      ...theme.typography.mono,
      marginTop: theme.spacing.sm,
      color: theme.colors.textMuted,
    },
    openBtn: {
      marginTop: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.accent,
    },
    openBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    openBtnDisabled: {
      backgroundColor: theme.colors.bgItem,
    },
    openBtnText: {
      ...theme.typography.headline,
      color: theme.colors.accentText,
    },
  });
