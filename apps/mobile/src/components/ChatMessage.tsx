import { Platform, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import Animated, { FadeInUp, Layout } from 'react-native-reanimated';

import type { ChatMessage } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface ChatMessageProps {
  message: ChatMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <Animated.View
        entering={FadeInUp.duration(300)}
        layout={Layout.springify()}
        style={[styles.messageWrapper, styles.messageWrapperUser]}
      >
        <View style={styles.userBubble}>
          <Text style={styles.userMessageText}>{message.content}</Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeInUp.duration(300).delay(50)}
      layout={Layout.springify()}
      style={[styles.messageWrapper, styles.messageWrapperAssistant]}
    >
      <Markdown style={markdownStyles}>
        {message.content || '\u258D'}
      </Markdown>
    </Animated.View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const markdownStyles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.textPrimary,
  },
  code_inline: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: 'rgba(200, 169, 70, 0.12)',
    color: colors.accent,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  code_block: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: colors.textPrimary,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  fence: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: colors.textPrimary,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  link: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  paragraph: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  bullet_list: {
    marginVertical: spacing.xs,
  },
  ordered_list: {
    marginVertical: spacing.xs,
  },
  list_item: {
    marginVertical: 2,
  },
  strong: {
    fontWeight: '700',
    color: colors.textPrimary,
  },
  em: {
    fontStyle: 'italic',
  },
});

const styles = StyleSheet.create({
  messageWrapper: {
    maxWidth: '92%',
  },
  messageWrapperUser: {
    alignSelf: 'flex-end',
  },
  messageWrapperAssistant: {
    alignSelf: 'flex-start',
    width: '100%',
  },
  userBubble: {
    backgroundColor: colors.userBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.userBubbleBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  userMessageText: {
    fontFamily: monoFont,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
});
