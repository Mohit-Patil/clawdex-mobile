import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { BridgeUiAction, BridgeUiSurface } from '../../api/types';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { BridgeUiWorkflowCard } from '../BridgeUiSurface';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => {
    const React = jest.requireActual('react');
    const reactNative = jest.requireActual('react-native');
    return React.createElement(reactNative.Text, null, name);
  },
}));

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
};

describe('BridgeUiWorkflowCard', () => {
  const theme = createAppTheme('dark');

  it('renders and resolves a dynamic Codex goal surface', () => {
    const surface: BridgeUiSurface = {
      id: 'goal-codex:thread-1',
      threadId: 'codex:thread-1',
      turnId: null,
      kind: 'goal',
      presentation: 'workflowCard',
      tone: 'info',
      title: 'Goal',
      subtitle: 'Active',
      bodyMarkdown: 'Verify the mobile dynamic goal card.',
      blocks: [
        {
          type: 'keyValue',
          items: [
            { label: 'Status', value: 'Active' },
            { label: 'Tokens used', value: '42' },
          ],
        },
        {
          type: 'progress',
          label: 'Budget used',
          value: 4,
          max: 10,
          detail: '40% complete',
        },
      ],
      actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
      dismissible: true,
    };
    const onAction = jest.fn<void, [BridgeUiSurface, BridgeUiAction]>();
    const onDismiss = jest.fn<void, [BridgeUiSurface]>();

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <BridgeUiWorkflowCard
            surface={surface}
            onAction={onAction}
            onDismiss={onDismiss}
          />
        </AppThemeProvider>
      );
    });

    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(findText(root, 'Goal')).toBe(true);
    expect(findText(root, 'Active')).toBe(true);
    expect(findText(root, 'Verify the mobile dynamic goal card.')).toBe(true);
    expect(findText(root, 'Status')).toBe(true);
    expect(findText(root, 'Tokens used')).toBe(true);
    expect(findText(root, '42')).toBe(true);
    expect(findText(root, 'Budget used')).toBe(true);
    expect(findText(root, '40% complete')).toBe(true);

    const toggleButton = findPressableByLabel(root, 'Collapse surface');
    act(() => {
      readOnPress(toggleButton.props)();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(findText(root, 'Status')).toBe(false);
    expect(findText(root, 'Tokens used')).toBe(false);
    expect(findText(root, 'Budget used')).toBe(false);
    expect(findText(root, 'Dismiss')).toBe(false);

    act(() => {
      readOnPress(findPressableByLabel(root, 'Expand surface').props)();
    });
    expect(findText(root, 'Status')).toBe(true);

    act(() => {
      readOnPress(findPressableByText(root, 'Dismiss').props)();
    });
    expect(onAction).toHaveBeenCalledWith(surface, surface.actions[0]);
  });
});

function findText(root: QueryableTestInstance, text: string): boolean {
  return root.findAll((node) => node.children.includes(text)).length > 0;
}

function findPressableByLabel(
  root: QueryableTestInstance,
  label: string
): QueryableTestInstance {
  const pressable = root.findAll(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityLabel === label
  )[0];
  if (!pressable) {
    throw new Error(`Unable to find pressable with label "${label}"`);
  }
  return pressable;
}

function findPressableByText(
  root: QueryableTestInstance,
  text: string
): QueryableTestInstance {
  const pressable = root.findAll(
    (node) => typeof node.props.onPress === 'function' && containsText(node, text)
  )[0];
  if (!pressable) {
    throw new Error(`Unable to find pressable with text "${text}"`);
  }
  return pressable;
}

function containsText(node: QueryableTestInstance, text: string): boolean {
  if (node.children.includes(text)) {
    return true;
  }
  return node.children.some(
    (child) =>
      typeof child === 'object' &&
      child !== null &&
      'children' in child &&
      containsText(child as QueryableTestInstance, text)
  );
}

function readOnPress(props: { onPress?: unknown }): () => void {
  if (typeof props.onPress !== 'function') {
    throw new Error('Expected onPress to be a function');
  }
  return props.onPress as () => void;
}

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected value to be defined');
  }
  return value;
}
