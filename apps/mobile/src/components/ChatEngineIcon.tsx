import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ChatEngine } from '../api/types';
import { getChatEngineLabel, resolveChatEngine } from '../chatEngines';

import codexMarkPng from '../../assets/brand/engine-codex.png';
import cursorMarkPng from '../../assets/brand/engine-cursor.png';
import opencodeMarkPng from '../../assets/brand/engine-opencode.png';

interface ChatEngineIconProps {
  engine?: ChatEngine | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

const ENGINE_MARKS = {
  codex: codexMarkPng,
  cursor: cursorMarkPng,
  opencode: opencodeMarkPng,
} as const;

export function ChatEngineIcon({ engine, size = 18, style }: ChatEngineIconProps) {
  const resolvedEngine = resolveChatEngine(engine);

  return (
    <View
      accessibilityLabel={getChatEngineLabel(resolvedEngine)}
      accessibilityRole="image"
      style={[
        styles.frame,
        {
          width: size,
          height: size,
          borderRadius: Math.max(5, Math.round(size * 0.24)),
        },
        style,
      ]}
    >
      <Image
        source={ENGINE_MARKS[resolvedEngine]}
        resizeMode="contain"
        style={{ width: size, height: size }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
});
