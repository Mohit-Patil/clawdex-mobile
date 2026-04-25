import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ClawdexTerminalViewProps } from './ClawdexTerminal.types';

let cachedNativeView: React.ComponentType<ClawdexTerminalViewProps> | null = null;

function FallbackNativeView({ placeholderText, style }: ClawdexTerminalViewProps) {
  return (
    <View style={[styles.fallback, style]}>
      <Text style={styles.fallbackText}>
        {placeholderText ?? 'The native terminal renderer is unavailable in this runtime.'}
      </Text>
    </View>
  );
}

function getNativeView(): React.ComponentType<ClawdexTerminalViewProps> {
  if (cachedNativeView) {
    return cachedNativeView;
  }

  try {
    cachedNativeView = requireNativeView<ClawdexTerminalViewProps>('ClawdexTerminal');
  } catch {
    cachedNativeView = FallbackNativeView;
  }

  return cachedNativeView;
}

export default function ClawdexTerminalView(props: ClawdexTerminalViewProps) {
  const NativeView = getNativeView();
  return <NativeView {...props} />;
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    backgroundColor: '#101114',
    borderRadius: 12,
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  fallbackText: {
    color: '#D1D5DB',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
});
