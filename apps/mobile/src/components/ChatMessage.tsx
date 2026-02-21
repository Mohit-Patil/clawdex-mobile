import { Ionicons } from '@expo/vector-icons';
import { Platform, StyleSheet, Text, View, Image } from 'react-native';
import Markdown, { type RenderRules } from 'react-native-markdown-display';
import Animated, { FadeInUp, Layout } from 'react-native-reanimated';

import type { ChatMessage } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface ChatMessageProps {
  message: ChatMessage;
}

interface TimelineEntry {
  title: string;
  details: string[];
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

  const timelineEntries =
    message.role === 'system' ? parseTimelineEntries(message.content) : null;
  if (timelineEntries && timelineEntries.length > 0) {
    return (
      <Animated.View
        entering={FadeInUp.duration(300).delay(50)}
        layout={Layout.springify()}
        style={[styles.messageWrapper, styles.messageWrapperAssistant]}
      >
        <View style={styles.timelineCardStack}>
          {timelineEntries.map((entry, index) => {
            const visual = toTimelineVisual(entry.title);
            return (
              <View
                key={`${message.id}-timeline-${String(index)}`}
                style={[styles.timelineCard, visual.isError && styles.timelineCardError]}
              >
                <View style={styles.timelineHeader}>
                  <Ionicons
                    name={visual.icon}
                    size={14}
                    color={visual.isError ? colors.statusError : colors.statusRunning}
                  />
                  <Text
                    style={[
                      styles.timelineTitle,
                      visual.useMonospaceTitle && styles.timelineTitleMono,
                    ]}
                  >
                    {entry.title}
                  </Text>
                </View>
                {entry.details.length > 0 ? (
                  <View style={styles.timelineDetailWrap}>
                    {entry.details.map((line, lineIndex) => (
                      <Text
                        key={`${message.id}-timeline-${String(index)}-line-${String(lineIndex)}`}
                        style={styles.timelineDetailLine}
                      >
                        {line}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
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
      <Markdown style={markdownStyles} rules={markdownRules}>
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
    backgroundColor: colors.inlineCodeBg,
    color: colors.inlineCodeText,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inlineCodeBorder,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  code_block: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: colors.bgInput,
    color: colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  fence: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: colors.bgInput,
    color: colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
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

const markdownRules: RenderRules = {
  image: (
    node,
    _children,
    _parent,
    _styles,
    allowedImageHandlers = [],
    defaultImageHandler = '',
  ) => {
    const src = readMarkdownAttr(node.attributes.src);
    if (!src) {
      return null;
    }

    const isAllowed = allowedImageHandlers.some((handler) =>
      src.toLowerCase().startsWith(handler.toLowerCase())
    );
    if (!isAllowed && defaultImageHandler === null) {
      return null;
    }

    const uri = isAllowed ? src : `${defaultImageHandler}${src}`;
    const alt = readMarkdownAttr(node.attributes.alt);

    return (
      <Image
        key={node.key}
        source={{ uri }}
        style={styles.markdownImage}
        resizeMode="contain"
        accessible={Boolean(alt)}
        accessibilityLabel={alt ?? undefined}
      />
    );
  },
};

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
  markdownImage: {
    width: '100%',
    minHeight: 120,
    maxHeight: 260,
    borderRadius: radius.sm,
    marginVertical: spacing.sm,
    backgroundColor: colors.bgInput,
  },
  timelineCardStack: {
    gap: spacing.sm,
  },
  timelineCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  timelineCardError: {
    borderColor: colors.statusError,
    backgroundColor: colors.errorBg,
  },
  timelineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  timelineTitle: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  timelineTitleMono: {
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 18,
  },
  timelineDetailWrap: {
    marginTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.xs,
    gap: 2,
  },
  timelineDetailLine: {
    fontFamily: monoFont,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
  },
});

function readMarkdownAttr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseTimelineEntries(content: string): TimelineEntry[] | null {
  if (!content.includes('•')) {
    return null;
  }

  const lines = content.split('\n');
  const entries: TimelineEntry[] = [];
  let current: TimelineEntry | null = null;

  const commitCurrent = () => {
    if (!current || !current.title) {
      current = null;
      return;
    }
    entries.push(current);
    current = null;
  };

  for (const line of lines) {
    const headingMatch = line.match(/^\s*•\s+(.+)$/);
    if (headingMatch) {
      commitCurrent();
      current = {
        title: headingMatch[1].trim(),
        details: [],
      };
      continue;
    }

    if (!current) {
      if (line.trim().length > 0) {
        return null;
      }
      continue;
    }

    const detail = normalizeTimelineDetail(line);
    if (detail) {
      current.details.push(detail);
    }
  }

  commitCurrent();
  return entries.length > 0 ? entries : null;
}

function normalizeTimelineDetail(line: string): string | null {
  if (line.trim().length === 0) {
    return null;
  }

  const withoutMarker = line.replace(/^\s*[└├│]\s*/, '').trimEnd();
  if (withoutMarker.trim().length === 0) {
    return null;
  }

  return withoutMarker;
}

function toTimelineVisual(title: string): {
  icon: keyof typeof Ionicons.glyphMap;
  useMonospaceTitle: boolean;
  isError: boolean;
} {
  const normalized = title.toLowerCase();
  const isError =
    normalized.includes('failed') || normalized.includes('error') || normalized.includes('aborted');

  if (isError) {
    return {
      icon: 'alert-circle-outline',
      useMonospaceTitle: false,
      isError: true,
    };
  }

  if (normalized.startsWith('ran ')) {
    return {
      icon: 'play-outline',
      useMonospaceTitle: true,
      isError: false,
    };
  }

  if (normalized.startsWith('explored')) {
    return {
      icon: 'search',
      useMonospaceTitle: false,
      isError: false,
    };
  }

  if (normalized.startsWith('called tool')) {
    return {
      icon: 'construct-outline',
      useMonospaceTitle: false,
      isError: false,
    };
  }

  if (normalized.startsWith('searched web')) {
    return {
      icon: 'globe-outline',
      useMonospaceTitle: false,
      isError: false,
    };
  }

  return {
    icon: 'document-text-outline',
    useMonospaceTitle: false,
    isError: false,
  };
}
