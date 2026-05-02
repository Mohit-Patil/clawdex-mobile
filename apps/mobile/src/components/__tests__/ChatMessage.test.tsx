import type { ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, Text } from 'react-native';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { ChatMessage as ApiChatMessage } from '../../api/types';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { ChatMessage, ToolActivityGroup } from '../ChatMessage';

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
};

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

describe('ChatMessage markdown formatting', () => {
  const theme = createAppTheme('dark');

  it('keeps assistant headings compact in chat', () => {
    const message: ApiChatMessage = {
      id: 'msg_heading',
      role: 'assistant',
      content: '# Role\n\nThe bridge connects the app to local runtimes.',
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
    const root = tree.root as QueryableTestInstance;

    const heading = root
      .findAll((node) => node.type === Text)
      .find((node) => flattenRenderedText(node.props.children).includes('Role'));

    if (!heading) {
      throw new Error('Expected heading text to render');
    }
    const headingStyle = StyleSheet.flatten(heading.props.style as never) as { fontSize?: number };
    expect(headingStyle.fontSize).toBeLessThanOrEqual(18);
  });

  it('renders markdown tables in a horizontal scroll area', () => {
    const message: ApiChatMessage = {
      id: 'msg_table',
      role: 'assistant',
      content:
        '| Listener | Routes | Purpose |\n| --- | --- | --- |\n| Main | `GET /rpc`, `GET /health` | Primary API for the app |',
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
    const root = tree.root as QueryableTestInstance;

    expect(
      root.findAll((node) => node.type === ScrollView).some((node) => node.props.horizontal === true)
    ).toBe(true);
  });
});

describe('ChatMessage Cursor rendering', () => {
  const theme = createAppTheme('dark');

  it('renders Cursor tool calls as compact activity rows', () => {
    const message: ApiChatMessage = {
      id: 'msg_cursor_tool',
      role: 'system',
      systemKind: 'tool',
      content:
        '• Called tool `read`\n  └ Input: /repo/package.json\n    { "name": "clawdex-mobile" }',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} engine="cursor" />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);
    const text = flattenTreeText(tree.root as QueryableTestInstance);

    expect(text).toContain('Reading package.json');
    expect(text).not.toContain('Called tool');
  });

  it('uses Cursor activity grouping instead of Codex tool summary cards', () => {
    const messages: ApiChatMessage[] = [
      {
        id: 'tool_read',
        role: 'system',
        systemKind: 'tool',
        content: '• Called tool `read`\n  └ Input: /repo/package.json',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      {
        id: 'tool_grep',
        role: 'system',
        systemKind: 'tool',
        content: '• Calling tool `grep`\n  └ Input: MainScreen',
        createdAt: '2026-04-17T00:00:01.000Z',
      },
    ];

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ToolActivityGroup messages={messages} engine="cursor" />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);
    const text = flattenTreeText(tree.root as QueryableTestInstance);

    expect(text).toContain('Reading package.json');
    expect(text).toContain('Searching MainScreen');
    expect(text).not.toContain('running');
    expect(text).not.toContain('2 tool calls');
  });

  it('renders Cursor thinking without Codex tap helper text', () => {
    const message: ApiChatMessage = {
      id: 'msg_cursor_reasoning',
      role: 'system',
      systemKind: 'reasoning',
      content: '• Reasoning\n  └ Checking current bridge state',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} engine="cursor" />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);
    const text = flattenTreeText(tree.root as QueryableTestInstance);

    expect(text).toContain('Thought');
    expect(text).not.toContain('Tap to show thinking');
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

function flattenRenderedText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenRenderedText).join('');
  }
  return '';
}

function flattenTreeText(node: QueryableTestInstance): string {
  if (node.type === Text) {
    return flattenRenderedText(node.props.children);
  }

  return node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : flattenTreeText(child as QueryableTestInstance)
    )
    .join('');
}
