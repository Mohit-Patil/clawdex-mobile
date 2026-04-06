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
import { extractLocalPreviewUrls } from '../browserPreview';
import { useAppTheme, type AppTheme } from '../theme';
import { toMarkdownImageSource } from './chatImageSource';

interface ChatMessageProps {
  message: ApiChatMessage;
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
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

function ChatMessageComponent({
  message,
  bridgeUrl = null,
  bridgeToken = null,
  onOpenLocalPreview,
}: ChatMessageProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
  const isUser = message.role === 'user';
  const markdownRules = useMemo(
    () => createMarkdownRules(bridgeUrl, bridgeToken, onOpenLocalPreview),
    [bridgeToken, bridgeUrl, onOpenLocalPreview]
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
  const localPreviewUrls = useMemo(
    () =>
      message.role === 'assistant' || message.role === 'system'
        ? extractLocalPreviewUrls(message.content)
        : [],
    [message.content, message.role]
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
                  <Ionicons name="document-text-outline" size={12} color={theme.colors.textMuted} />
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
                {renderUserTextWithMentions(
                  block.value,
                  styles.userInlineMentionText
                )}
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
                    color={theme.colors.textMuted}
                  />
                  <Text style={styles.reasoningTitle}>{entry.title}</Text>
                  {hasDetails ? (
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={theme.colors.textMuted}
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
                    color={visual.isError ? theme.colors.statusError : theme.colors.warning}
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
                    color={visual.isError ? theme.colors.statusError : theme.colors.statusRunning}
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
                      color={theme.colors.textMuted}
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
      {localPreviewUrls.length > 0 && onOpenLocalPreview ? (
        <View style={styles.localPreviewLinkList}>
          {localPreviewUrls.map((targetUrl) => (
            <Pressable
              key={`${message.id}-${targetUrl}`}
              onPress={() => onOpenLocalPreview(targetUrl)}
              style={({ pressed }) => [
                styles.localPreviewLink,
                pressed && styles.localPreviewLinkPressed,
              ]}
            >
              <Ionicons name="globe-outline" size={14} color={theme.colors.textPrimary} />
              <Text style={styles.localPreviewLinkText} numberOfLines={1}>
                {`Open ${targetUrl} in Browser`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
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
    prevProps.bridgeToken === nextProps.bridgeToken &&
    prevProps.onOpenLocalPreview === nextProps.onOpenLocalPreview
  );
}

export const ChatMessage = memo(ChatMessageComponent, areChatMessagePropsEqual);
ChatMessage.displayName = 'ChatMessage';

export const ToolActivityGroup = memo(function ToolActivityGroupComponent({
  messages,
}: ToolActivityGroupProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
          <Ionicons name="construct-outline" size={14} color={theme.colors.textMuted} />
          <Text style={styles.toolGroupTitle}>{summary}</Text>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={theme.colors.textMuted}
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

const createMarkdownStyles = (theme: AppTheme) => StyleSheet.create({
  body: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  code_inline: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: theme.colors.inlineCodeBg,
    color: theme.colors.inlineCodeText,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.inlineCodeBorder,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  code_block: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
  },
  fence: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
  },
  link: {
    color: theme.colors.accent,
    textDecorationLine: 'underline',
  },
  paragraph: {
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  bullet_list: {
    marginVertical: theme.spacing.xs,
  },
  ordered_list: {
    marginVertical: theme.spacing.xs,
  },
  list_item: {
    marginVertical: 2,
  },
  strong: {
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  em: {
    fontStyle: 'italic',
  },
});

function createMarkdownRules(
  bridgeUrl: string | null,
  bridgeToken: string | null,
  onOpenLocalPreview?: (targetUrl: string) => void
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
          onPress={() => openMarkdownLink(href, onLinkPress, onOpenLocalPreview)}
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

const createStyles = (theme: AppTheme) => {
  const subAgentBorder = theme.isDark
    ? 'rgba(245, 165, 36, 0.35)'
    : 'rgba(217, 119, 6, 0.24)';
  const subAgentBackground = theme.isDark
    ? 'rgba(245, 165, 36, 0.08)'
    : 'rgba(217, 119, 6, 0.08)';

  return StyleSheet.create({
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
    backgroundColor: theme.colors.userBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.userBubbleBorder,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    ...(theme.isDark
      ? {}
      : {
          boxShadow: '0px 3px 10px rgba(15, 31, 54, 0.08)',
        }),
  },
  userBubbleWithAttachments: {
    minWidth: 196,
  },
  userBubbleContent: {
    gap: theme.spacing.sm,
  },
  userMessageText: {
    fontFamily: monoFont,
    fontSize: 14,
    color: theme.colors.textPrimary,
    lineHeight: 20,
  },
  userInlineMentionText: {
    color: theme.colors.textSecondary,
    backgroundColor: theme.colors.bgItem,
    borderColor: theme.colors.userBubbleBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 3,
    overflow: 'hidden',
  },
  userFileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.userBubbleBorder,
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    maxWidth: '100%',
  },
  userFileChipText: {
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textMuted,
    flexShrink: 1,
  },
  markdownImage: {
    width: '100%',
    borderRadius: theme.radius.sm,
    marginVertical: theme.spacing.sm,
    backgroundColor: theme.colors.bgInput,
  },
  markdownImageFallback: {
    minHeight: 120,
    maxHeight: 260,
  },
  timelineCardStack: {
    gap: theme.spacing.sm,
  },
  subAgentCardStack: {
    gap: theme.spacing.xs + 2,
  },
  reasoningStack: {
    gap: theme.spacing.xs,
  },
  reasoningCard: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgCanvasAccent,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 1,
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
    gap: theme.spacing.sm,
  },
  reasoningTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 12,
    letterSpacing: 0.2,
    textTransform: 'none',
    flex: 1,
  },
  reasoningPreview: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    lineHeight: 17,
    marginTop: theme.spacing.xs,
  },
  reasoningDetailWrap: {
    marginTop: theme.spacing.xs,
    gap: theme.spacing.xs,
  },
  reasoningDetailLine: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 17,
  },
  reasoningToggleText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  localPreviewLinkList: {
    marginTop: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  localPreviewLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    alignSelf: 'flex-start',
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    maxWidth: '100%',
  },
  localPreviewLinkPressed: {
    opacity: 0.84,
  },
  localPreviewLinkText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flexShrink: 1,
  },
  toolGroupCard: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
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
    gap: theme.spacing.sm,
  },
  toolGroupTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  toolGroupList: {
    marginTop: theme.spacing.xs,
    gap: 4,
  },
  toolGroupRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  toolGroupBullet: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    lineHeight: 16,
    width: 8,
  },
  toolGroupRowText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 16,
    flex: 1,
    fontFamily: monoFont,
  },
  toolGroupMoreText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
    paddingLeft: theme.spacing.lg,
  },
  subAgentCard: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: subAgentBorder,
    backgroundColor: subAgentBackground,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 1,
  },
  subAgentCardError: {
    borderColor: theme.colors.statusError,
    backgroundColor: theme.colors.errorBg,
  },
  subAgentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  subAgentTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  subAgentDetailWrap: {
    marginTop: theme.spacing.xs,
    paddingLeft: theme.spacing.lg + 2,
    gap: 2,
  },
  subAgentDetailLine: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    lineHeight: 16,
  },
  timelineCard: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
  },
  timelineCardError: {
    borderColor: theme.colors.statusError,
    backgroundColor: theme.colors.errorBg,
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
    gap: theme.spacing.sm,
  },
  timelineTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
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
    marginTop: theme.spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderLight,
    paddingTop: theme.spacing.xs,
    gap: 2,
  },
  timelineToggleText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  timelineDetailLine: {
    fontFamily: monoFont,
    fontSize: 11,
    lineHeight: 16,
    color: theme.colors.textSecondary,
  },
});
};

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

function renderUserTextWithMentions(
  value: string,
  mentionStyle: TextProps['style']
): Array<string | ReactElement> {
  const pattern = /(^|[^A-Za-z0-9_])(@[A-Za-z0-9._-]+)/g;
  const parts: Array<string | ReactElement> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(value)) !== null) {
    const prefix = match[1] ?? '';
    const token = match[2] ?? '';
    const startIndex = match.index + prefix.length;
    const prefixStartIndex = match.index;

    if (prefixStartIndex > lastIndex) {
      parts.push(value.slice(lastIndex, prefixStartIndex));
    }
    if (prefix) {
      parts.push(prefix);
    }
    parts.push(
      <Text key={`mention-${String(key)}`} style={mentionStyle}>
        {token}
      </Text>
    );
    key += 1;
    lastIndex = startIndex + token.length;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [value];
}

function MarkdownImage({
  source,
  accessibilityLabel,
}: {
  source: ImageSourcePropType;
  accessibilityLabel?: string;
}): ReactElement {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
      const label = toLocalFileReferenceLabel(fileMatch[1]) ?? toPathBasename(fileMatch[1]);
      if (textContainsMentionLabel(pendingTextLines.join('\n'), label)) {
        continue;
      }
      flushTextBlock();
      blocks.push({
        kind: 'file',
        value: label,
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textContainsMentionLabel(text: string, label: string): boolean {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return false;
  }

  const pattern = new RegExp(`(^|[^\\w])@${escapeRegex(trimmedLabel)}(?=$|[^\\w])`, 'i');
  return pattern.test(text);
}

function openMarkdownLink(
  href: string,
  onLinkPress?: (url: string) => boolean,
  onOpenLocalPreview?: (targetUrl: string) => void
): void {
  if (onOpenLocalPreview && extractLocalPreviewUrls(href).length > 0) {
    onOpenLocalPreview(href);
    return;
  }

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
