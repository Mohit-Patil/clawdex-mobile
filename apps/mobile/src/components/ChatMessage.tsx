import { Ionicons } from '@expo/vector-icons';
import { memo, useMemo, useState, type ReactElement } from 'react';
import {
  Image,
  Pressable,
  type ImageSourcePropType,
  Linking,
  Platform,
  StyleSheet,
  Text,
  type TextProps,
  View,
} from 'react-native';
import Markdown, { type RenderRules } from 'react-native-markdown-display';

import type { ChatMessage as ApiChatMessage } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';
import { toMarkdownImageSource } from './chatImageSource';

interface ChatMessageProps {
  message: ApiChatMessage;
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
}

interface ToolActivityGroupProps {
  messages: ApiChatMessage[];
}

interface TimelineEntry {
  title: string;
  details: string[];
}

type UserMessageBlock =
  | { kind: 'text'; value: string }
  | { kind: 'file'; value: string }
  | { kind: 'image'; source: ImageSourcePropType; accessibilityLabel?: string };

function ChatMessageComponent({ message, bridgeUrl = null, bridgeToken = null }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const markdownRules = useMemo(
    () => createMarkdownRules(bridgeUrl, bridgeToken),
    [bridgeToken, bridgeUrl]
  );
  const [expandedTimelineEntries, setExpandedTimelineEntries] = useState<
    Record<string, boolean>
  >({});
  const [expandedReasoningEntries, setExpandedReasoningEntries] = useState<
    Record<string, boolean>
  >({});
  const userBlocks = useMemo(
    () =>
      isUser ? parseUserMessageBlocks(message.content, bridgeUrl, bridgeToken) : [],
    [bridgeToken, bridgeUrl, isUser, message.content]
  );

  const renderedMessage = isUser ? (
    <View style={[styles.messageWrapper, styles.messageWrapperUser]}>
      <View style={[styles.userBubble, userBlocks.length > 1 && styles.userBubbleWithAttachments]}>
        <View style={styles.userBubbleContent}>
          {userBlocks.map((block, index) => {
            if (block.kind === 'image') {
              return (
                <MarkdownImage
                  key={`${message.id}-image-${String(index)}`}
                  source={block.source}
                  accessibilityLabel={block.accessibilityLabel}
                />
              );
            }

            if (block.kind === 'file') {
              return (
                <View key={`${message.id}-file-${String(index)}`} style={styles.userFileChip}>
                  <Ionicons name="document-text-outline" size={12} color={colors.textMuted} />
                  <Text style={styles.userFileChipText} numberOfLines={1}>
                    {block.value}
                  </Text>
                </View>
              );
            }

            return (
              <SelectableMessageText
                key={`${message.id}-text-${String(index)}`}
                style={styles.userMessageText}
              >
                {block.value}
              </SelectableMessageText>
            );
          })}
        </View>
      </View>
    </View>
  ) : null;

  if (renderedMessage) {
    return renderedMessage;
  }

  const timelineEntries =
    message.role === 'system' ? parseTimelineEntries(message.content) : null;
  if (message.role === 'system' && message.systemKind === 'reasoning') {
    const reasoningEntries =
      timelineEntries && timelineEntries.length > 0
        ? timelineEntries
        : [{ title: 'Reasoning', details: [message.content] }];

    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <View style={styles.reasoningStack}>
          {reasoningEntries.map((entry, index) => {
            const reasoningKey = `${message.id}-reasoning-${String(index)}`;
            const hasDetails = entry.details.length > 0;
            const expanded = expandedReasoningEntries[reasoningKey] === true;
            const preview = hasDetails ? summarizeReasoningPreview(entry.details) : null;

            return (
              <Pressable
                key={reasoningKey}
                disabled={!hasDetails}
                onPress={() => {
                  if (!hasDetails) {
                    return;
                  }
                  setExpandedReasoningEntries((previous) => ({
                    ...previous,
                    [reasoningKey]: !previous[reasoningKey],
                  }));
                }}
                style={({ pressed }) => [
                  styles.reasoningCard,
                  hasDetails && styles.reasoningCardInteractive,
                  pressed && hasDetails && styles.reasoningCardPressed,
                ]}
              >
                <View style={styles.reasoningHeader}>
                  <Ionicons
                    name="sparkles-outline"
                    size={13}
                    color={colors.textMuted}
                  />
                  <Text style={styles.reasoningTitle}>{entry.title}</Text>
                  {hasDetails ? (
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={colors.textMuted}
                    />
                  ) : null}
                </View>
                {!expanded && preview ? (
                  <SelectableMessageText
                    style={styles.reasoningPreview}
                    numberOfLines={3}
                  >
                    {preview}
                  </SelectableMessageText>
                ) : null}
                {expanded && hasDetails ? (
                  <View style={styles.reasoningDetailWrap}>
                    {entry.details.map((line, lineIndex) => (
                      <SelectableMessageText
                        key={`${reasoningKey}-line-${String(lineIndex)}`}
                        style={styles.reasoningDetailLine}
                      >
                        {line}
                      </SelectableMessageText>
                    ))}
                  </View>
                ) : null}
                {hasDetails ? (
                  <Text style={styles.reasoningToggleText}>
                    {expanded ? 'Tap to hide thinking' : 'Tap to show thinking'}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }
  if (message.role === 'system' && message.systemKind === 'subAgent') {
    const subAgentEntries =
      timelineEntries && timelineEntries.length > 0
        ? timelineEntries
        : [{ title: message.content, details: [] }];

    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <View style={styles.subAgentCardStack}>
          {subAgentEntries.map((entry, index) => {
            const visual = toSubAgentVisual(entry.title);
            return (
              <View
                key={`${message.id}-subagent-${String(index)}`}
                style={[
                  styles.subAgentCard,
                  visual.isError && styles.subAgentCardError,
                ]}
              >
                <View style={styles.subAgentHeader}>
                  <Ionicons
                    name={visual.icon}
                    size={14}
                    color={visual.isError ? colors.statusError : '#F5A524'}
                  />
                  <Text style={styles.subAgentTitle}>{entry.title}</Text>
                </View>
                {entry.details.length > 0 ? (
                  <View style={styles.subAgentDetailWrap}>
                    {entry.details.map((line, lineIndex) => (
                      <SelectableMessageText
                        key={`${message.id}-subagent-${String(index)}-line-${String(lineIndex)}`}
                        style={styles.subAgentDetailLine}
                      >
                        {line}
                      </SelectableMessageText>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
    );
  }
  if (timelineEntries && timelineEntries.length > 0) {
    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <View style={styles.timelineCardStack}>
          {timelineEntries.map((entry, index) => {
            const visual = toTimelineVisual(entry.title);
            const timelineKey = `${message.id}-timeline-${String(index)}`;
            const hasDetails = entry.details.length > 0;
            const expanded = expandedTimelineEntries[timelineKey] === true;
            const toggleLabel = expanded
              ? 'Tap to hide output'
              : entry.details.length <= 1
                ? 'Tap to show output'
                : `Tap to show ${String(entry.details.length)} lines`;
            return (
              <Pressable
                key={`${message.id}-timeline-${String(index)}`}
                disabled={!hasDetails}
                onPress={() => {
                  if (!hasDetails) {
                    return;
                  }
                  setExpandedTimelineEntries((previous) => ({
                    ...previous,
                    [timelineKey]: !previous[timelineKey],
                  }));
                }}
                style={({ pressed }) => [
                  styles.timelineCard,
                  visual.isError && styles.timelineCardError,
                  hasDetails && styles.timelineCardInteractive,
                  pressed && hasDetails && styles.timelineCardPressed,
                ]}
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
                    numberOfLines={expanded ? 3 : 1}
                  >
                    {entry.title}
                  </Text>
                  {hasDetails ? (
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={colors.textMuted}
                    />
                  ) : null}
                </View>
                {hasDetails ? (
                  <Text style={styles.timelineToggleText}>{toggleLabel}</Text>
                ) : null}
                {expanded && entry.details.length > 0 ? (
                  <View style={styles.timelineDetailWrap}>
                    {entry.details.map((line, lineIndex) => (
                      <SelectableMessageText
                        key={`${message.id}-timeline-${String(index)}-line-${String(lineIndex)}`}
                        style={styles.timelineDetailLine}
                      >
                        {line}
                      </SelectableMessageText>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <Markdown style={markdownStyles} rules={markdownRules}>
        {message.content || '\u258D'}
      </Markdown>
    </View>
  );
}

function areChatMessagePropsEqual(
  prevProps: ChatMessageProps,
  nextProps: ChatMessageProps
): boolean {
  const previous = prevProps.message;
  const next = nextProps.message;

  if (previous === next) {
    return true;
  }

  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.content === next.content &&
    previous.createdAt === next.createdAt &&
    previous.systemKind === next.systemKind &&
    prevProps.bridgeUrl === nextProps.bridgeUrl &&
    prevProps.bridgeToken === nextProps.bridgeToken
  );
}

export const ChatMessage = memo(ChatMessageComponent, areChatMessagePropsEqual);
ChatMessage.displayName = 'ChatMessage';

export const ToolActivityGroup = memo(function ToolActivityGroupComponent({
  messages,
}: ToolActivityGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => {
    const flattened: Array<{ id: string; title: string }> = [];
    for (const message of messages) {
      const parsed = parseTimelineEntries(message.content);
      if (parsed && parsed.length > 0) {
        parsed.forEach((entry, index) => {
          flattened.push({
            id: `${message.id}-${String(index)}`,
            title: entry.title,
          });
        });
        continue;
      }

      flattened.push({
        id: message.id,
        title: message.content.trim(),
      });
    }
    return flattened.filter((entry) => entry.title.length > 0);
  }, [messages]);

  if (entries.length === 0) {
    return null;
  }

  const previewEntries = expanded ? entries : entries.slice(0, 3);
  const hiddenCount = Math.max(entries.length - previewEntries.length, 0);
  const summary = summarizeToolGroup(entries.map((entry) => entry.title));

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <Pressable
        onPress={() => setExpanded((previous) => !previous)}
        style={({ pressed }) => [
          styles.toolGroupCard,
          styles.toolGroupCardInteractive,
          pressed && styles.toolGroupCardPressed,
        ]}
      >
        <View style={styles.toolGroupHeader}>
          <Ionicons name="construct-outline" size={14} color={colors.textMuted} />
          <Text style={styles.toolGroupTitle}>{summary}</Text>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={colors.textMuted}
          />
        </View>

        <View style={styles.toolGroupList}>
          {previewEntries.map((entry) => (
            <View key={entry.id} style={styles.toolGroupRow}>
              <Text style={styles.toolGroupBullet}>{'\u2022'}</Text>
              <Text style={styles.toolGroupRowText} numberOfLines={1}>
                {entry.title}
              </Text>
            </View>
          ))}
          {!expanded && hiddenCount > 0 ? (
            <Text style={styles.toolGroupMoreText}>{`+${String(hiddenCount)} more`}</Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
});
ToolActivityGroup.displayName = 'ToolActivityGroup';

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

function createMarkdownRules(
  bridgeUrl: string | null,
  bridgeToken: string | null
): RenderRules {
  return {
    text: (node, _children, _parent, styles, inheritedStyles = {}) => (
      <SelectableMessageText key={node.key} style={[inheritedStyles, styles.text]}>
        {node.content}
      </SelectableMessageText>
    ),
    textgroup: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.textgroup}>
        {children}
      </SelectableMessageText>
    ),
    strong: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.strong}>
        {children}
      </SelectableMessageText>
    ),
    em: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.em}>
        {children}
      </SelectableMessageText>
    ),
    s: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.s}>
        {children}
      </SelectableMessageText>
    ),
    code_inline: (node, _children, _parent, styles, inheritedStyles = {}) => (
      <SelectableMessageText key={node.key} style={[inheritedStyles, styles.code_inline]}>
        {node.content}
      </SelectableMessageText>
    ),
    code_block: (node, _children, _parent, styles, inheritedStyles = {}) => {
      const content =
        typeof node.content === 'string' && node.content.charAt(node.content.length - 1) === '\n'
          ? node.content.substring(0, node.content.length - 1)
          : node.content;
      return (
        <SelectableMessageText key={node.key} style={[inheritedStyles, styles.code_block]}>
          {content}
        </SelectableMessageText>
      );
    },
    fence: (node, _children, _parent, styles, inheritedStyles = {}) => {
      const content =
        typeof node.content === 'string' && node.content.charAt(node.content.length - 1) === '\n'
          ? node.content.substring(0, node.content.length - 1)
          : node.content;
      return (
        <SelectableMessageText key={node.key} style={[inheritedStyles, styles.fence]}>
          {content}
        </SelectableMessageText>
      );
    },
    hardbreak: (node, _children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.hardbreak}>
        {'\n'}
      </SelectableMessageText>
    ),
    softbreak: (node, _children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.softbreak}>
        {'\n'}
      </SelectableMessageText>
    ),
    inline: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.inline}>
        {children}
      </SelectableMessageText>
    ),
    span: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.span}>
        {children}
      </SelectableMessageText>
    ),
    link: (node, children, _parent, styles, onLinkPress) => {
      const href = readMarkdownAttr(node.attributes.href);
      if (!href) {
        return (
          <SelectableMessageText key={node.key} style={styles.link}>
            {children}
          </SelectableMessageText>
        );
      }

      const localFileReference = toLocalFileReferenceLabel(href);
      if (localFileReference) {
        return (
          <SelectableMessageText key={node.key} style={styles.code_inline}>
            {localFileReference}
          </SelectableMessageText>
        );
      }

      return (
        <SelectableMessageText
          key={node.key}
          style={styles.link}
          onPress={() => openMarkdownLink(href, onLinkPress)}
        >
          {children}
        </SelectableMessageText>
      );
    },
    image: (node) => {
      const src = readMarkdownAttr(node.attributes.src);
      if (!src) {
        return null;
      }
      const source = toMarkdownImageSource(src, bridgeUrl, bridgeToken);
      if (!source) {
        return null;
      }
      const alt = readMarkdownAttr(node.attributes.alt);

      return (
        <MarkdownImage
          key={node.key}
          source={source}
          accessibilityLabel={alt ?? undefined}
        />
      );
    },
  };
}

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
  userBubbleWithAttachments: {
    minWidth: 196,
  },
  userBubbleContent: {
    gap: spacing.sm,
  },
  userMessageText: {
    fontFamily: monoFont,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  userFileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.userBubbleBorder,
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxWidth: '100%',
  },
  userFileChipText: {
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textMuted,
    flexShrink: 1,
  },
  markdownImage: {
    width: '100%',
    borderRadius: radius.sm,
    marginVertical: spacing.sm,
    backgroundColor: colors.bgInput,
  },
  markdownImageFallback: {
    minHeight: 120,
    maxHeight: 260,
  },
  timelineCardStack: {
    gap: spacing.sm,
  },
  subAgentCardStack: {
    gap: spacing.xs + 2,
  },
  reasoningStack: {
    gap: spacing.xs,
  },
  reasoningCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(208, 213, 223, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 1,
  },
  reasoningCardInteractive: {
    overflow: 'hidden',
  },
  reasoningCardPressed: {
    opacity: 0.84,
  },
  reasoningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  reasoningTitle: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 12,
    letterSpacing: 0.2,
    textTransform: 'none',
    flex: 1,
  },
  reasoningPreview: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  reasoningDetailWrap: {
    marginTop: spacing.xs,
    gap: spacing.xs,
  },
  reasoningDetailLine: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  reasoningToggleText: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  toolGroupCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  toolGroupCardInteractive: {
    overflow: 'hidden',
  },
  toolGroupCardPressed: {
    opacity: 0.84,
  },
  toolGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  toolGroupTitle: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  toolGroupList: {
    marginTop: spacing.xs,
    gap: 4,
  },
  toolGroupRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  toolGroupBullet: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 16,
    width: 8,
  },
  toolGroupRowText: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 16,
    flex: 1,
    fontFamily: monoFont,
  },
  toolGroupMoreText: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
    paddingLeft: spacing.lg,
  },
  subAgentCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(245, 165, 36, 0.35)',
    backgroundColor: 'rgba(245, 165, 36, 0.08)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 1,
  },
  subAgentCardError: {
    borderColor: colors.statusError,
    backgroundColor: colors.errorBg,
  },
  subAgentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  subAgentTitle: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  subAgentDetailWrap: {
    marginTop: spacing.xs,
    paddingLeft: spacing.lg + 2,
    gap: 2,
  },
  subAgentDetailLine: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 16,
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
  timelineCardInteractive: {
    overflow: 'hidden',
  },
  timelineCardPressed: {
    opacity: 0.82,
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
  timelineToggleText: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
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

function SelectableMessageText({ children, ...props }: TextProps): ReactElement {
  return (
    <Text selectable={props.selectable ?? !props.onPress} {...props}>
      {children}
    </Text>
  );
}

function MarkdownImage({
  source,
  accessibilityLabel,
}: {
  source: ImageSourcePropType;
  accessibilityLabel?: string;
}): ReactElement {
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  return (
    <Image
      source={source}
      style={[
        styles.markdownImage,
        aspectRatio ? { aspectRatio } : styles.markdownImageFallback,
      ]}
      resizeMode="contain"
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
      onLoad={(event) => {
        const width = event.nativeEvent.source?.width;
        const height = event.nativeEvent.source?.height;
        if (
          typeof width !== 'number' ||
          typeof height !== 'number' ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0
        ) {
          return;
        }

        const nextAspectRatio = width / height;
        setAspectRatio((previousAspectRatio) =>
          previousAspectRatio === nextAspectRatio ? previousAspectRatio : nextAspectRatio
        );
      }}
    />
  );
}

function parseUserMessageBlocks(
  content: string,
  bridgeUrl: string | null,
  bridgeToken: string | null
): UserMessageBlock[] {
  const blocks: UserMessageBlock[] = [];
  const pendingTextLines: string[] = [];

  const flushTextBlock = () => {
    if (pendingTextLines.length === 0) {
      return;
    }

    const value = pendingTextLines.join('\n');
    pendingTextLines.length = 0;
    if (!value.trim()) {
      return;
    }

    blocks.push({
      kind: 'text',
      value,
    });
  };

  for (const line of content.split('\n')) {
    const localImageMatch = line.match(/^\[local image:\s*(.+?)\]$/i);
    if (localImageMatch) {
      const source = toMarkdownImageSource(localImageMatch[1], bridgeUrl, bridgeToken);
      if (source) {
        flushTextBlock();
        blocks.push({
          kind: 'image',
          source,
          accessibilityLabel: toPathBasename(localImageMatch[1]),
        });
        continue;
      }
    }

    const remoteImageMatch = line.match(/^\[image:\s*(.+?)\]$/i);
    if (remoteImageMatch) {
      const source = toMarkdownImageSource(remoteImageMatch[1], bridgeUrl, bridgeToken);
      if (source) {
        flushTextBlock();
        blocks.push({
          kind: 'image',
          source,
          accessibilityLabel: toPathBasename(remoteImageMatch[1]),
        });
        continue;
      }
    }

    const fileMatch = line.match(/^\[file:\s*(.+?)\]$/i);
    if (fileMatch) {
      flushTextBlock();
      blocks.push({
        kind: 'file',
        value: toLocalFileReferenceLabel(fileMatch[1]) ?? toPathBasename(fileMatch[1]),
      });
      continue;
    }

    pendingTextLines.push(line);
  }

  flushTextBlock();

  if (blocks.length === 0) {
    return [
      {
        kind: 'text',
        value: content,
      },
    ];
  }

  return blocks;
}

function toPathBasename(path: string): string {
  const normalizedPath = path.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return 'image';
  }

  const basename = normalizedPath.split('/').filter(Boolean).pop();
  return basename && basename.length > 0 ? basename : normalizedPath;
}

function openMarkdownLink(
  href: string,
  onLinkPress?: (url: string) => boolean
): void {
  const shouldOpen = onLinkPress ? onLinkPress(href) !== false : true;
  if (!shouldOpen) {
    return;
  }
  void Linking.openURL(href).catch(() => {});
}

function toLocalFileReferenceLabel(href: string): string | null {
  let normalizedHref = href.trim();
  if (!normalizedHref) {
    return null;
  }

  try {
    normalizedHref = decodeURIComponent(normalizedHref);
  } catch {
    // Keep original href when decode fails.
  }

  if (normalizedHref.startsWith('file://')) {
    normalizedHref = normalizedHref.replace(/^file:\/\//, '');
  }

  const isPosixPath = normalizedHref.startsWith('/');
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(normalizedHref);
  if (!isPosixPath && !isWindowsPath) {
    return null;
  }

  const anchorLineMatch = normalizedHref.match(/#L(\d+)(?:C\d+)?$/i);
  const suffixLineMatch = normalizedHref.match(/:(\d+)(?::\d+)?$/);

  const line = anchorLineMatch?.[1] ?? suffixLineMatch?.[1] ?? null;
  let pathOnly = normalizedHref;
  if (anchorLineMatch) {
    pathOnly = normalizedHref.slice(0, normalizedHref.length - anchorLineMatch[0].length);
  } else if (suffixLineMatch) {
    pathOnly = normalizedHref.slice(0, normalizedHref.length - suffixLineMatch[0].length);
  }

  const basename = pathOnly.split(/[\\/]/).filter(Boolean).pop();
  if (!basename) {
    return line ? `line ${line}` : null;
  }

  return line ? `${basename}:${line}` : basename;
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

function summarizeReasoningPreview(details: string[]): string | null {
  const preview = details
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
  return preview.length > 0 ? preview : null;
}

function summarizeToolGroup(titles: string[]): string {
  const normalized = titles.map((title) => title.trim().toLowerCase());
  if (normalized.every((title) => title.startsWith('ran '))) {
    return `${String(titles.length)} command${titles.length === 1 ? '' : 's'}`;
  }
  if (normalized.every((title) => title.startsWith('called tool'))) {
    return `${String(titles.length)} tool call${titles.length === 1 ? '' : 's'}`;
  }
  if (normalized.every((title) => title.startsWith('subagent task'))) {
    return `${String(titles.length)} subagent task${titles.length === 1 ? '' : 's'}`;
  }
  if (normalized.every((title) => title.startsWith('searched web'))) {
    return `${String(titles.length)} web search${titles.length === 1 ? '' : 'es'}`;
  }
  if (normalized.every((title) => title.startsWith('applied file changes'))) {
    return `${String(titles.length)} file change${titles.length === 1 ? '' : 's'}`;
  }
  return `${String(titles.length)} tool call${titles.length === 1 ? '' : 's'}`;
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

  if (normalized.startsWith('subagent task')) {
    return {
      icon: 'sparkles-outline',
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

function toSubAgentVisual(title: string): {
  icon: keyof typeof Ionicons.glyphMap;
  isError: boolean;
} {
  const normalized = title.toLowerCase();
  const isError =
    normalized.includes('failed') || normalized.includes('error') || normalized.includes('aborted');

  if (isError) {
    return {
      icon: 'alert-circle-outline',
      isError: true,
    };
  }

  if (normalized.includes('waiting')) {
    return {
      icon: 'pause-circle-outline',
      isError: false,
    };
  }

  if (normalized.includes('closed')) {
    return {
      icon: 'checkmark-circle-outline',
      isError: false,
    };
  }

  if (normalized.includes('spawn')) {
    return {
      icon: 'sparkles-outline',
      isError: false,
    };
  }

  return {
    icon: 'git-branch-outline',
    isError: false,
  };
}
