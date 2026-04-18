import type { ReactNode } from 'react';
import { Modal } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { ChatMessage as ApiChatMessage } from '../../api/types';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { ChatMessage } from '../ChatMessage';

jest.mock('react-native-reanimated', () => {
  const reactNative = jest.requireActual('react-native');

  return {
    __esModule: true,
    default: {
      Image: reactNative.Image,
    },
    clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
    useAnimatedStyle: (updater: () => unknown) => updater(),
    useSharedValue: <T,>(value: T) => ({ value }),
    withTiming: <T,>(value: T) => value,
  };
});

jest.mock('react-native-gesture-handler', () => {
  const React = jest.requireActual('react');
  const reactNative = jest.requireActual('react-native');

  const createGesture = () => {
    const chain = {
      enabled: () => chain,
      onStart: () => chain,
      onUpdate: () => chain,
      onEnd: () => chain,
      minDistance: () => chain,
      numberOfTaps: () => chain,
      maxDuration: () => chain,
    };
    return chain;
  };

  return {
    GestureDetector: ({ children }: { children: ReactNode }) => (
      <reactNative.View>{children}</reactNative.View>
    ),
    Gesture: {
      Pinch: () => createGesture(),
      Pan: () => createGesture(),
      Tap: () => createGesture(),
      Simultaneous: (...gestures: unknown[]) => gestures[0],
      Exclusive: (...gestures: unknown[]) => gestures[0],
    },
  };
});

describe('ChatMessage image viewer', () => {
  const theme = createAppTheme('dark');

  it('opens transcript images in a full-screen modal when tapped', () => {
    const message: ApiChatMessage = {
      id: 'msg_image',
      role: 'assistant',
      content: '[image: data:image/png;base64,abc123]',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);

    const modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(false);

    const trigger = tree.root.findByProps({
      testID: 'chat-image-fullscreen-trigger',
    });
    act(() => {
      readOnPress(trigger.props)();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(true);

    const backdrop = tree.root.findByProps({
      testID: 'chat-image-fullscreen-backdrop',
    });
    act(() => {
      readOnPress(backdrop.props)();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });
});

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected value to be set');
  }
  return value;
}

function readOnPress(props: Record<string, unknown>): () => void {
  if (typeof props.onPress !== 'function') {
    throw new Error('Expected press handler');
  }
  return props.onPress as () => void;
}
