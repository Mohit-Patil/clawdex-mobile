import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '../theme';

export type ActivityTone = 'running' | 'complete' | 'error' | 'idle';

interface ActivityBarProps {
  title: string;
  detail?: string | null;
  tone: ActivityTone;
  runningPhrases?: string[];
}

const ICON_BY_TONE: Record<ActivityTone, keyof typeof Ionicons.glyphMap> = {
  running: 'sparkles-outline',
  complete: 'checkmark-circle-outline',
  error: 'close-circle-outline',
  idle: 'ellipse-outline',
};

const COLOR_BY_TONE: Record<ActivityTone, string> = {
  running: colors.statusRunning,
  complete: colors.statusComplete,
  error: colors.statusError,
  idle: colors.statusIdle,
};

export function ActivityBar({ title, detail, tone, runningPhrases }: ActivityBarProps) {
  const color = COLOR_BY_TONE[tone];
  const phrases = useMemo(
    () =>
      (runningPhrases ?? [])
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length > 0),
    [runningPhrases]
  );
  const phrasesKey = phrases.join('|');
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [dotFrame, setDotFrame] = useState(0);

  useEffect(() => {
    setPhraseIndex(0);
    setDotFrame(0);
  }, [tone, phrasesKey]);

  useEffect(() => {
    if (tone !== 'running') {
      return;
    }

    const phraseTimer =
      phrases.length > 1
        ? setInterval(() => {
            setPhraseIndex((prev) => (prev + 1) % phrases.length);
          }, 1400)
        : null;

    const dotsTimer = setInterval(() => {
      setDotFrame((prev) => (prev + 1) % 4);
    }, 450);

    return () => {
      if (phraseTimer) clearInterval(phraseTimer);
      clearInterval(dotsTimer);
    };
  }, [tone, phrases.length]);

  const runningText =
    phrases.length > 0 ? phrases[phraseIndex % phrases.length] : (detail ?? title);
  const dots = '.'.repeat(dotFrame);
  const text =
    tone === 'running'
      ? `${runningText}${dots}`
      : `${title}${detail ? ` · ${detail}` : ''}`;

  return (
    <View style={styles.container}>
      <View style={[styles.rail, { backgroundColor: color }]} />
      {tone === 'running' ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Ionicons name={ICON_BY_TONE[tone]} size={14} color={color} />
      )}
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgSidebar,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 2,
  },
  rail: {
    width: 3,
    borderRadius: radius.full,
    alignSelf: 'stretch',
  },
  text: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },
});
