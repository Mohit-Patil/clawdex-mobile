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

interface TermsScreenProps {
  termsUrl: string | null;
  onOpenDrawer: () => void;
}

export function TermsScreen({ termsUrl, onOpenDrawer }: TermsScreenProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [openingTerms, setOpeningTerms] = useState(false);

  const openTerms = useCallback(async () => {
    if (!termsUrl || openingTerms) {
      return;
    }

    try {
      setOpeningTerms(true);
      const supported = await Linking.canOpenURL(termsUrl);
      if (!supported) {
        Alert.alert('Cannot open link', 'The terms URL is not supported on this device.');
        return;
      }
      await Linking.openURL(termsUrl);
    } catch {
      Alert.alert('Could not open link', 'Please open the terms URL manually.');
    } finally {
      setOpeningTerms(false);
    }
  }, [openingTerms, termsUrl]);

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
          <Ionicons name="document-text" size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>Terms</Text>
        </BlurView>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Section title="Use Of Service">
            This mobile app is a client for interacting with a user-owned host bridge and repository.
            You are responsible for commands, commits, and approvals executed through your setup.
          </Section>

          <Section title="Account And Credentials">
            You must keep bridge tokens and provider credentials confidential.
            Do not share devices or hosts that have active bridge credentials without protection.
          </Section>

          <Section title="Acceptable Use">
            You may not use this app to access systems you do not own or have explicit authorization
            to control.
          </Section>

          <Section title="Operational Risk">
            Terminal and Git actions can change files and repository history on your host.
            Review commands and approvals before execution.
          </Section>

          <Section title="Availability And Changes">
            Features may change over time. You are responsible for maintaining your local bridge
            configuration and secure network setup.
          </Section>

          <Text style={styles.sectionLabel}>Official Terms</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Text style={styles.cardTitle}>Terms URL</Text>
            <Text selectable style={styles.termsUrl}>
              {termsUrl ?? 'Not configured. Set EXPO_PUBLIC_TERMS_OF_SERVICE_URL.'}
            </Text>
            <Pressable
              disabled={!termsUrl || openingTerms}
              onPress={() => void openTerms()}
              style={({ pressed }) => [
                styles.openBtn,
                (!termsUrl || openingTerms) && styles.openBtnDisabled,
                pressed && termsUrl && !openingTerms && styles.openBtnPressed
              ]}
            >
              <Ionicons name="open-outline" size={16} color={colors.white} />
              <Text style={styles.openBtnText}>
                {openingTerms ? 'Opening...' : 'Open terms'}
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
    termsUrl: {
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
