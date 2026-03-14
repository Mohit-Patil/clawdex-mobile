import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, spacing } from '../theme';
import {
  appendVoiceWaveformSample,
  createVoiceWaveformSeed,
  fallbackVoiceWaveformLevel,
  formatVoiceRecordingDuration,
  normalizeVoiceMetering,
  VOICE_WAVEFORM_BAR_COUNT,
  VOICE_WAVEFORM_SAMPLE_INTERVAL_MS,
} from './voiceWaveform';

const MIN_BAR_HEIGHT = 6;
const MAX_BAR_HEIGHT = 26;

interface VoiceRecordingWaveformProps {
  durationMillis: number;
  metering?: number | null;
}

interface WaveformBarProps {
  ageOpacity: number;
  level: number;
}

function WaveformBar({ ageOpacity, level }: WaveformBarProps) {
  const animatedLevel = useSharedValue(level);

  useEffect(() => {
    animatedLevel.value = withTiming(level, {
      duration: VOICE_WAVEFORM_SAMPLE_INTERVAL_MS + 30,
    });
  }, [animatedLevel, level]);

  const animatedStyle = useAnimatedStyle(() => {
    const height =
      MIN_BAR_HEIGHT + animatedLevel.value * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
    const opacity = Math.min(
      1,
      Math.max(0.18, ageOpacity * (0.45 + animatedLevel.value * 0.55))
    );

    return {
      height,
      opacity,
    };
  });

  return (
    <View style={styles.barTrack}>
      <Animated.View style={[styles.bar, animatedStyle]} />
    </View>
  );
}

export function VoiceRecordingWaveform({
  durationMillis,
  metering,
}: VoiceRecordingWaveformProps) {
  const [samples, setSamples] = useState<number[]>(() =>
    createVoiceWaveformSeed(VOICE_WAVEFORM_BAR_COUNT)
  );
  const meteringRef = useRef<number | null | undefined>(metering);
  meteringRef.current = metering;

  useEffect(() => {
    let step = 0;

    setSamples(createVoiceWaveformSeed(VOICE_WAVEFORM_BAR_COUNT));

    const interval = setInterval(() => {
      step += 1;
      const level =
        meteringRef.current == null
          ? fallbackVoiceWaveformLevel(step)
          : normalizeVoiceMetering(meteringRef.current);

      setSamples((currentSamples) =>
        appendVoiceWaveformSample(currentSamples, level, VOICE_WAVEFORM_BAR_COUNT)
      );
    }, VOICE_WAVEFORM_SAMPLE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const formattedDuration = formatVoiceRecordingDuration(durationMillis);

  return (
    <View
      accessible
      accessibilityLabel={`Voice recording in progress, ${formattedDuration} elapsed`}
      style={styles.container}
    >
      <View style={styles.metaRow}>
        <View style={styles.labelRow}>
          <View style={styles.liveDot} />
          <Text style={styles.label}>Listening</Text>
        </View>
        <Text style={styles.timer}>{formattedDuration}</Text>
      </View>

      <View style={styles.waveformRow}>
        {samples.map((sample, index) => {
          const denominator = Math.max(1, samples.length - 1);
          const ageOpacity = 0.24 + (index / denominator) * 0.72;

          return (
            <WaveformBar
              key={String(index)}
              ageOpacity={ageOpacity}
              level={sample}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: 40,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  labelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  liveDot: {
    backgroundColor: colors.error,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  timer: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  waveformRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
    height: MAX_BAR_HEIGHT,
    overflow: 'hidden',
  },
  barTrack: {
    alignItems: 'center',
    height: MAX_BAR_HEIGHT,
    justifyContent: 'center',
    width: 3,
  },
  bar: {
    backgroundColor: colors.textPrimary,
    borderRadius: 999,
    width: 3,
  },
});
