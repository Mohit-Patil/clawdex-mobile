import { useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export type LoadingGlyphVariant = 'spinner' | 'pulse' | 'bars' | 'ring';

interface LoadingGlyphProps {
  color: string;
  variant: LoadingGlyphVariant;
  size?: 'small' | 'medium';
  style?: StyleProp<ViewStyle>;
}

const BASE_PHASE = 0.28;
const PULSE_COUNT = 3;

export function LoadingGlyph({
  color,
  variant,
  size = 'small',
  style,
}: LoadingGlyphProps) {
  const pulseRefs = useRef(
    Array.from({ length: PULSE_COUNT }, () => new Animated.Value(BASE_PHASE))
  );
  const ringScale = useRef(new Animated.Value(0.86)).current;
  const ringOpacity = useRef(new Animated.Value(0.38)).current;
  const pulses = pulseRefs.current;

  const specs = useMemo(() => {
    if (size === 'medium') {
      return {
        spinner: 'small' as const,
        dotSize: 5,
        dotGap: 4,
        barWidth: 3,
        barHeight: 13,
        ringSize: 15,
        ringInnerSize: 5,
      };
    }

    return {
      spinner: 'small' as const,
      dotSize: 4,
      dotGap: 3,
      barWidth: 3,
      barHeight: 10,
      ringSize: 12,
      ringInnerSize: 4,
    };
  }, [size]);

  useEffect(() => {
    if (variant !== 'pulse' && variant !== 'bars') {
      return;
    }

    pulses.forEach((phase) => phase.setValue(BASE_PHASE));
    const animation = Animated.loop(
      Animated.stagger(
        120,
        pulses.map((phase) =>
          Animated.sequence([
            Animated.timing(phase, {
              toValue: 1,
              duration: 320,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(phase, {
              toValue: BASE_PHASE,
              duration: 320,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ])
        )
      )
    );

    animation.start();
    return () => {
      animation.stop();
    };
  }, [pulses, variant]);

  useEffect(() => {
    if (variant !== 'ring') {
      return;
    }

    ringScale.setValue(0.86);
    ringOpacity.setValue(0.38);
    const animation = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(ringScale, {
            toValue: 1.12,
            duration: 540,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(ringScale, {
            toValue: 0.86,
            duration: 540,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(ringOpacity, {
            toValue: 0.92,
            duration: 540,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(ringOpacity, {
            toValue: 0.38,
            duration: 540,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    animation.start();
    return () => {
      animation.stop();
    };
  }, [ringOpacity, ringScale, variant]);

  if (variant === 'spinner') {
    return (
      <View style={style}>
        <ActivityIndicator size={specs.spinner} color={color} />
      </View>
    );
  }

  if (variant === 'ring') {
    return (
      <View
        style={[
          styles.center,
          { width: specs.ringSize + 2, height: specs.ringSize + 2 },
          style,
        ]}
      >
        <Animated.View
          style={[
            styles.ring,
            {
              width: specs.ringSize,
              height: specs.ringSize,
              borderRadius: specs.ringSize / 2,
              borderColor: color,
              opacity: ringOpacity,
              transform: [{ scale: ringScale }],
            },
          ]}
        />
        <View
          style={{
            position: 'absolute',
            width: specs.ringInnerSize,
            height: specs.ringInnerSize,
            borderRadius: specs.ringInnerSize / 2,
            backgroundColor: color,
            opacity: 0.92,
          }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.row, style]}>
      {pulses.map((phase, index) => {
        const commonStyle = {
          marginRight: index === pulses.length - 1 ? 0 : specs.dotGap,
          opacity: phase.interpolate({
            inputRange: [BASE_PHASE, 1],
            outputRange: [0.42, 1],
          }),
        } as const;

        if (variant === 'bars') {
          return (
            <Animated.View
              key={`bar-${String(index)}`}
              style={[
                styles.bar,
                commonStyle,
                {
                  width: specs.barWidth,
                  height: specs.barHeight,
                  backgroundColor: color,
                  transform: [
                    {
                      scaleY: phase.interpolate({
                        inputRange: [BASE_PHASE, 1],
                        outputRange: [0.58, 1],
                      }),
                    },
                  ],
                },
              ]}
            />
          );
        }

        return (
          <Animated.View
            key={`dot-${String(index)}`}
            style={[
              styles.dot,
              commonStyle,
              {
                width: specs.dotSize,
                height: specs.dotSize,
                borderRadius: specs.dotSize / 2,
                backgroundColor: color,
                transform: [
                  {
                    scale: phase.interpolate({
                      inputRange: [BASE_PHASE, 1],
                      outputRange: [0.78, 1],
                    }),
                  },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    flexShrink: 0,
  },
  bar: {
    borderRadius: 999,
    flexShrink: 0,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
  },
});
