import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, radius, spacing, typography } from '../theme';

interface TermsScreenProps {
  termsUrl: string | null;
  onOpenDrawer: () => void;
}

export function TermsScreen({ termsUrl, onOpenDrawer }: TermsScreenProps) {
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
        <BlurView intensity={80} tint="dark" style={styles.header}>
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
          <BlurView intensity={50} tint="dark" style={styles.card}>
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
  return (
    <>
      <Text style={styles.sectionLabel}>{title}</Text>
      <BlurView intensity={50} tint="dark" style={styles.card}>
        <Text style={styles.bodyText}>{children}</Text>
      </BlurView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHighlight
  },
  menuBtn: { padding: spacing.xs },
  headerTitle: { ...typography.headline, color: colors.textPrimary },
  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    color: colors.textMuted,
    marginLeft: spacing.xs
  },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden'
  },
  bodyText: {
    ...typography.body,
    color: colors.textSecondary
  },
  cardTitle: {
    ...typography.headline,
    color: colors.textPrimary
  },
  termsUrl: {
    ...typography.mono,
    marginTop: spacing.sm,
    color: colors.textMuted
  },
  openBtn: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.accent
  },
  openBtnPressed: {
    backgroundColor: colors.accentPressed
  },
  openBtnDisabled: {
    backgroundColor: colors.bgItem
  },
  openBtnText: {
    ...typography.headline,
    color: colors.white
  }
});
