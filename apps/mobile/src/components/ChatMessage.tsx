import { Ionicons } from '@expo/vector-icons';
import { memo, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Image,
  Modal,
  Pressable,
  type ImageSourcePropType,
  Linking,
  StyleSheet,
  Text,
  type TextProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Markdown, { type RenderRules } from 'react-native-markdown-display';
import Animated, {
  clamp,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { ChatMessage as ApiChatMessage } from '../api/types';
import { extractLocalPreviewUrls } from '../browserPreview';
import { useAppTheme, type AppTheme } from '../theme';
import { toMarkdownImageSource } from './chatImageSource';
import {
  computerUseActionIconName,
  isComputerUseTraceEntry,
  parseComputerUseTraceEntry,
} from './computerUseTrace';

interface ChatMessageProps {
  message: ApiChatMessage;
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
}

interface ToolActivityGroupProps {
  messages: ApiChatMessage[];
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
}

interface TimelineEntry {
  title: string;
  details: string[];
}

interface ToolGroupEntry {
  id: string;
  title: string;
  details: string[];
}

interface TimelineDetailMediaPreview {
  source: ImageSourcePropType;
  accessibilityLabel?: string;
}

interface TimelineDetailPreview {
  textDetails: string[];
  images: TimelineDetailMediaPreview[];
}

interface ComputerUseTimelineProps {
  entries: ToolGroupEntry[];
  bridgeUrl: string | null;
  bridgeToken: string | null;
}

type MessageBlock =
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
  const messageBlocks = useMemo(
    () => parseMessageBlocks(message.content, bridgeUrl, bridgeToken),
    [bridgeToken, bridgeUrl, message.content]
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
      <View
        style={[
          styles.userBubble,
          messageBlocks.length > 1 && styles.userBubbleWithAttachments,
        ]}
      >
        <View style={styles.userBubbleContent}>
          {messageBlocks.map((block, index) => {
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

  if (message.role === 'assistant') {
    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <View style={styles.assistantContent}>
          {messageBlocks.map((block, index) => {
            if (block.kind === 'image') {
              return (
                <MarkdownImage
                  key={`${message.id}-assistant-image-${String(index)}`}
                  source={block.source}
                  accessibilityLabel={block.accessibilityLabel}
                />
              );
            }

            if (block.kind === 'file') {
              return (
                <View
                  key={`${message.id}-assistant-file-${String(index)}`}
                  style={styles.userFileChip}
                >
                  <Ionicons
                    name="document-text-outline"
                    size={12}
                    color={theme.colors.textMuted}
                  />
                  <Text style={styles.userFileChipText} numberOfLines={1}>
                    {block.value}
                  </Text>
                </View>
              );
            }

            return (
              <Markdown
                key={`${message.id}-assistant-text-${String(index)}`}
                style={markdownStyles}
                rules={markdownRules}
              >
                {block.value || '\u258D'}
              </Markdown>
            );
          })}
        </View>
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

  const timelineEntries =
    message.role === 'system' ? parseTimelineEntries(message.content) : null;
  if (message.role === 'system' && message.systemKind === 'compaction') {
    return (
      <View
        style={[
          styles.messageWrapper,
          styles.messageWrapperAssistant,
          styles.messageWrapperFullWidth,
        ]}
      >
        <View style={styles.compactionRow}>
          <View style={styles.compactionLine} />
          <View style={styles.compactionBadge}>
            <Text style={styles.compactionText}>
              {formatCompactionLabel(message.content)}
            </Text>
          </View>
          <View style={styles.compactionLine} />
        </View>
      </View>
    );
  }
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
    const timelineToolEntries = timelineEntries.map((entry, index) => ({
      id: `${message.id}-timeline-${String(index)}`,
      title: entry.title,
      details: entry.details,
    }));
    if (entriesAreComputerUseTimeline(timelineToolEntries)) {
      return (
        <ComputerUseTimeline
          entries={timelineToolEntries}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
        />
      );
    }

    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <View style={styles.timelineCardStack}>
          {timelineEntries.map((entry, index) => {
            const visual = toTimelineVisual(entry.title);
            const detailPreview = toTimelineDetailPreview(
              entry,
              bridgeUrl,
              bridgeToken
            );
            const hasImages = detailPreview.images.length > 0;
            const textDetails = detailPreview.textDetails;
            const timelineKey = `${message.id}-timeline-${String(index)}`;
            const hasDetails = textDetails.length > 0;
            const expanded = expandedTimelineEntries[timelineKey] === true;
            const toggleLabel = hasDetails
              ? hasImages && isViewedImageEntry(entry.title, textDetails)
                ? expanded
                  ? 'Tap to hide path'
                  : 'Tap to show path'
                : expanded
                  ? 'Tap to hide details'
                  : textDetails.length <= 1
                    ? 'Tap to show details'
                    : `Tap to show ${String(textDetails.length)} lines`
              : null;
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
                {detailPreview.images.map((image, imageIndex) => (
                  <MarkdownImage
                    key={`${timelineKey}-image-${String(imageIndex)}`}
                    source={image.source}
                    accessibilityLabel={image.accessibilityLabel}
                  />
                ))}
                {expanded && textDetails.length > 0 ? (
                  <View style={styles.timelineDetailWrap}>
                    {textDetails.map((line, lineIndex) => (
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
  bridgeUrl = null,
  bridgeToken = null,
}: ToolActivityGroupProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [expandedEntryIds, setExpandedEntryIds] = useState<Record<string, boolean>>({});
  const entries = useMemo(() => {
    const flattened: ToolGroupEntry[] = [];
    for (const message of messages) {
      const parsed = parseTimelineEntries(message.content);
      if (parsed && parsed.length > 0) {
        parsed.forEach((entry, index) => {
          flattened.push({
            id: `${message.id}-${String(index)}`,
            title: entry.title,
            details: entry.details,
          });
        });
        continue;
      }

      flattened.push({
        id: message.id,
        title: message.content.trim(),
        details: [],
      });
    }
    return flattened.filter((entry) => entry.title.length > 0);
  }, [messages]);

  if (entries.length === 0) {
    return null;
  }

  if (entriesAreComputerUseTimeline(entries)) {
    return (
      <ComputerUseTimeline
        entries={entries}
        bridgeUrl={bridgeUrl}
        bridgeToken={bridgeToken}
      />
    );
  }

  const previewEntries = expanded ? entries : entries.slice(0, 3);
  const hiddenCount = Math.max(entries.length - previewEntries.length, 0);
  const summary = summarizeToolGroup(entries.map((entry) => entry.title));

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <View style={styles.toolGroupCard}>
        <Pressable
          onPress={() => setExpanded((previous) => !previous)}
          style={({ pressed }) => [
            styles.toolGroupHeaderPressable,
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
        </Pressable>

        <View style={styles.toolGroupList}>
          {previewEntries.map((entry) => {
            const visual = toTimelineVisual(entry.title);
            const detailPreview = toTimelineDetailPreview(
              entry,
              bridgeUrl,
              bridgeToken
            );
            const hasImages = detailPreview.images.length > 0;
            const textDetails = detailPreview.textDetails;
            const hasDetails = textDetails.length > 0;
            const entryExpanded = expandedEntryIds[entry.id] === true;

            if (!expanded) {
              const previewImage = detailPreview.images[0] ?? null;
              return (
                <View key={entry.id} style={styles.toolGroupPreviewEntry}>
                  <View style={styles.toolGroupRow}>
                    <Text style={styles.toolGroupBullet}>{'\u2022'}</Text>
                    <Text style={styles.toolGroupRowText} numberOfLines={1}>
                      {entry.title}
                    </Text>
                  </View>
                  {previewImage ? (
                    <MarkdownImage
                      key={`${entry.id}-preview-image`}
                      source={previewImage.source}
                      accessibilityLabel={previewImage.accessibilityLabel}
                    />
                  ) : null}
                </View>
              );
            }

            return (
              <Pressable
                key={entry.id}
                disabled={!hasDetails}
                onPress={() => {
                  if (!hasDetails) {
                    return;
                  }
                  setExpandedEntryIds((previous) => ({
                    ...previous,
                    [entry.id]: !previous[entry.id],
                  }));
                }}
                style={({ pressed }) => [
                  styles.toolGroupEntryCard,
                  hasDetails && styles.toolGroupEntryCardInteractive,
                  visual.isError && styles.timelineCardError,
                  pressed && hasDetails && styles.toolGroupEntryCardPressed,
                ]}
              >
                <View style={styles.toolGroupEntryHeader}>
                  <Ionicons
                    name={visual.icon}
                    size={14}
                    color={
                      visual.isError
                        ? theme.colors.statusError
                        : theme.colors.statusRunning
                    }
                  />
                  <Text
                    style={[
                      styles.toolGroupEntryTitle,
                      visual.useMonospaceTitle && styles.toolGroupEntryTitleMono,
                    ]}
                    numberOfLines={entryExpanded ? 3 : 1}
                  >
                    {entry.title}
                  </Text>
                  {hasDetails ? (
                    <Ionicons
                      name={entryExpanded ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={theme.colors.textMuted}
                    />
                  ) : null}
                </View>
                {hasDetails ? (
                  <Text style={styles.toolGroupEntryToggleText}>
                    {hasImages && isViewedImageEntry(entry.title, textDetails)
                      ? entryExpanded
                        ? 'Tap to hide path'
                        : 'Tap to show path'
                      : entryExpanded
                        ? 'Tap to hide output'
                        : textDetails.length <= 1
                          ? 'Tap to show output'
                          : `Tap to show ${String(textDetails.length)} lines`}
                  </Text>
                ) : null}
                {detailPreview.images.map((image, imageIndex) => (
                  <MarkdownImage
                    key={`${entry.id}-image-${String(imageIndex)}`}
                    source={image.source}
                    accessibilityLabel={image.accessibilityLabel}
                  />
                ))}
                {entryExpanded && hasDetails ? (
                  <View style={styles.toolGroupEntryDetailWrap}>
                    {textDetails.map((line, lineIndex) => (
                      <SelectableMessageText
                        key={`${entry.id}-line-${String(lineIndex)}`}
                        style={styles.toolGroupEntryDetailLine}
                      >
                        {line}
                      </SelectableMessageText>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
          {!expanded && hiddenCount > 0 ? (
            <Text style={styles.toolGroupMoreText}>{`+${String(hiddenCount)} more`}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
});
ToolActivityGroup.displayName = 'ToolActivityGroup';

function ComputerUseTimeline({
  entries,
  bridgeUrl,
  bridgeToken,
}: ComputerUseTimelineProps): ReactElement | null {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const parsedEntries = entries
    .map((entry) => {
      const parsed = parseComputerUseTraceEntry(entry);
      if (!parsed) {
        return null;
      }
      return {
        entry,
        parsed,
        detailPreview: toTimelineDetailPreview(entry, bridgeUrl, bridgeToken),
      };
    })
    .filter(
      (
        entry
      ): entry is {
        entry: ToolGroupEntry;
        parsed: NonNullable<ReturnType<typeof parseComputerUseTraceEntry>>;
        detailPreview: TimelineDetailPreview;
      } => entry !== null
    );

  if (parsedEntries.length === 0) {
    return null;
  }

  return (
    <View
      style={[
        styles.messageWrapper,
        styles.messageWrapperAssistant,
        styles.messageWrapperFullWidth,
      ]}
    >
      <View style={styles.computerUseTrace}>
        {parsedEntries.length > 1 ? (
          <View style={styles.computerUseTraceSummaryRow}>
            <Ionicons name="desktop-outline" size={14} color={theme.colors.textMuted} />
            <Text style={styles.computerUseTraceSummaryText}>
              {`${String(parsedEntries.length)} actions`}
            </Text>
          </View>
        ) : null}

        <View style={styles.computerUseTraceStepList}>
          {parsedEntries.map(({ entry, parsed, detailPreview }) => {
            return (
              <View key={entry.id} style={styles.computerUseTraceStep}>
                <View style={styles.computerUseTraceStepBody}>
                  <View style={styles.computerUseTraceStepTopRow}>
                    <Ionicons
                      name={computerUseActionIconName(parsed.actionKey)}
                      size={13}
                      color={theme.colors.textMuted}
                    />
                    <Text style={styles.computerUseTraceAction}>{parsed.actionLabel}</Text>
                    {parsed.appName ? (
                      <Text style={styles.computerUseTraceInlineMeta} numberOfLines={1}>
                        {parsed.appName}
                      </Text>
                    ) : null}
                  </View>

                  {detailPreview.images.map((image, imageIndex) => (
                    <MarkdownImage
                      key={`${entry.id}-computer-use-image-${String(imageIndex)}`}
                      source={image.source}
                      accessibilityLabel={image.accessibilityLabel}
                    />
                  ))}

                  {!detailPreview.images.length && parsed.windowTitle ? (
                    <Text style={styles.computerUseTraceInlineMeta} numberOfLines={1}>
                      {parsed.windowTitle}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const createMarkdownStyles = (theme: AppTheme) => StyleSheet.create({
  body: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  code_inline: {
    fontFamily: theme.fonts.monoRegular,
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
    fontFamily: theme.fonts.monoRegular,
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
    fontFamily: theme.fonts.monoRegular,
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

function entriesAreComputerUseTimeline(entries: Array<Pick<ToolGroupEntry, 'title'>>): boolean {
  return entries.length > 0 && entries.every((entry) => isComputerUseTraceEntry(entry));
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
  messageWrapperFullWidth: {
    alignSelf: 'stretch',
    maxWidth: '100%',
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
  assistantContent: {
    gap: theme.spacing.xs,
  },
  userMessageText: {
    fontFamily: theme.fonts.monoRegular,
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
    fontFamily: theme.fonts.monoRegular,
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
  markdownImagePressable: {
    alignSelf: 'stretch',
  },
  markdownImagePressablePressed: {
    opacity: 0.88,
  },
  markdownImageFallback: {
    minHeight: 120,
    maxHeight: 260,
  },
  imageViewerModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.94)',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xxl,
    paddingBottom: theme.spacing.xl,
  },
  imageViewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  imageViewerHintChip: {
    borderRadius: theme.radius.full,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
  },
  imageViewerHintText: {
    ...theme.typography.caption,
    color: 'rgba(255, 255, 255, 0.84)',
    fontSize: 11,
    fontWeight: '600',
  },
  imageViewerCloseButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  imageViewerCloseButtonPressed: {
    opacity: 0.84,
  },
  imageViewerStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageViewerImage: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bgInput,
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
  compactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    alignSelf: 'stretch',
    marginVertical: theme.spacing.xs,
  },
  compactionLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderLight,
  },
  compactionBadge: {
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 5,
  },
  compactionText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  toolGroupCard: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
  },
  toolGroupHeaderPressable: {
    marginHorizontal: -theme.spacing.md,
    marginTop: -(theme.spacing.sm + 2),
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm + 2,
    paddingBottom: 2,
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
  toolGroupPreviewEntry: {
    gap: theme.spacing.xs,
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
    fontFamily: theme.fonts.monoRegular,
  },
  toolGroupMoreText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
    paddingLeft: theme.spacing.lg,
  },
  toolGroupEntryCard: {
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.xs,
  },
  toolGroupEntryCardInteractive: {
    overflow: 'hidden',
  },
  toolGroupEntryCardPressed: {
    opacity: 0.82,
  },
  toolGroupEntryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  toolGroupEntryTitle: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
    lineHeight: 16,
  },
  toolGroupEntryTitleMono: {
    fontFamily: theme.fonts.monoRegular,
    fontSize: 12,
  },
  toolGroupEntryToggleText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
    paddingLeft: theme.spacing.lg + 2,
  },
  toolGroupEntryDetailWrap: {
    marginTop: theme.spacing.xs,
    marginLeft: theme.spacing.lg + 2,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.borderLight,
    paddingLeft: theme.spacing.sm,
    gap: 2,
  },
  toolGroupEntryDetailLine: {
    fontFamily: theme.fonts.monoRegular,
    fontSize: 11,
    lineHeight: 16,
    color: theme.colors.textSecondary,
  },
  computerUseTrace: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm + 2,
    gap: theme.spacing.sm,
  },
  computerUseTraceSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: 2,
  },
  computerUseTraceSummaryText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  computerUseTraceStepList: {
    gap: theme.spacing.xs + 2,
  },
  computerUseTraceStep: {
    gap: theme.spacing.xs,
  },
  computerUseTraceStepBody: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  computerUseTraceStepTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing.xs,
  },
  computerUseTraceAction: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  computerUseTraceInlineMeta: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    lineHeight: 16,
    fontSize: 11,
    flexShrink: 1,
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
    fontFamily: theme.fonts.monoRegular,
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
    fontFamily: theme.fonts.monoRegular,
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
  const [viewerVisible, setViewerVisible] = useState(false);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const modalImageWidth = Math.max(windowWidth - theme.spacing.xl * 2, 160);
  const modalImageHeight = Math.max(windowHeight - theme.spacing.xxl * 4, 220);
  const viewerImageFrame = useMemo(
    () => resolveContainedImageFrame(modalImageWidth, modalImageHeight, aspectRatio),
    [aspectRatio, modalImageHeight, modalImageWidth]
  );
  const scale = useSharedValue(1);
  const scaleOffset = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const translateOffsetX = useSharedValue(0);
  const translateOffsetY = useSharedValue(0);

  useEffect(() => {
    if (!viewerVisible) {
      scale.value = 1;
      scaleOffset.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      translateOffsetX.value = 0;
      translateOffsetY.value = 0;
    }
  }, [
    scale,
    scaleOffset,
    translateOffsetX,
    translateOffsetY,
    translateX,
    translateY,
    viewerVisible,
  ]);

  const modalImageAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .enabled(viewerVisible)
        .onStart(() => {
          scaleOffset.value = scale.value;
        })
        .onUpdate((event) => {
          const nextScale = clamp(scaleOffset.value * event.scale, 1, 4);
          const maxX = Math.max(
            (viewerImageFrame.width * nextScale - viewerImageFrame.width) / 2,
            0
          );
          const maxY = Math.max(
            (viewerImageFrame.height * nextScale - viewerImageFrame.height) / 2,
            0
          );
          scale.value = nextScale;
          translateX.value = clamp(translateX.value, -maxX, maxX);
          translateY.value = clamp(translateY.value, -maxY, maxY);
        })
        .onEnd(() => {
          if (scale.value <= 1.01) {
            scale.value = withTiming(1);
            translateX.value = withTiming(0);
            translateY.value = withTiming(0);
            scaleOffset.value = 1;
            translateOffsetX.value = 0;
            translateOffsetY.value = 0;
            return;
          }

          scaleOffset.value = scale.value;
          translateOffsetX.value = translateX.value;
          translateOffsetY.value = translateY.value;
        }),
    [
      scale,
      scaleOffset,
      translateOffsetX,
      translateOffsetY,
      translateX,
      translateY,
      viewerImageFrame.height,
      viewerImageFrame.width,
      viewerVisible,
    ]
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(viewerVisible)
        .minDistance(2)
        .onStart(() => {
          translateOffsetX.value = translateX.value;
          translateOffsetY.value = translateY.value;
        })
        .onUpdate((event) => {
          if (scale.value <= 1.01) {
            translateX.value = 0;
            translateY.value = 0;
            return;
          }

          const maxX = Math.max(
            (viewerImageFrame.width * scale.value - viewerImageFrame.width) / 2,
            0
          );
          const maxY = Math.max(
            (viewerImageFrame.height * scale.value - viewerImageFrame.height) / 2,
            0
          );
          translateX.value = clamp(translateOffsetX.value + event.translationX, -maxX, maxX);
          translateY.value = clamp(translateOffsetY.value + event.translationY, -maxY, maxY);
        })
        .onEnd(() => {
          translateOffsetX.value = translateX.value;
          translateOffsetY.value = translateY.value;
        }),
    [
      scale,
      translateOffsetX,
      translateOffsetY,
      translateX,
      translateY,
      viewerImageFrame.height,
      viewerImageFrame.width,
      viewerVisible,
    ]
  );

  const doubleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .enabled(viewerVisible)
        .numberOfTaps(2)
        .maxDuration(250)
        .onEnd((_event, success) => {
          if (!success) {
            return;
          }

          if (scale.value > 1.01) {
            scale.value = withTiming(1);
            translateX.value = withTiming(0);
            translateY.value = withTiming(0);
            scaleOffset.value = 1;
            translateOffsetX.value = 0;
            translateOffsetY.value = 0;
            return;
          }

          scale.value = withTiming(2);
          scaleOffset.value = 2;
          translateX.value = withTiming(0);
          translateY.value = withTiming(0);
          translateOffsetX.value = 0;
          translateOffsetY.value = 0;
        }),
    [
      scale,
      scaleOffset,
      translateOffsetX,
      translateOffsetY,
      translateX,
      translateY,
      viewerVisible,
    ]
  );

  const viewerGesture = useMemo(
    () => Gesture.Exclusive(doubleTapGesture, Gesture.Simultaneous(pinchGesture, panGesture)),
    [doubleTapGesture, panGesture, pinchGesture]
  );

  return (
    <>
      <Pressable
        testID="chat-image-fullscreen-trigger"
        onPress={() => setViewerVisible(true)}
        style={({ pressed }) => [
          styles.markdownImagePressable,
          pressed && styles.markdownImagePressablePressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? 'Chat image'}
        accessibilityHint="Opens the image full screen"
      >
        <Image
          source={source}
          style={[
            styles.markdownImage,
            aspectRatio ? { aspectRatio } : styles.markdownImageFallback,
          ]}
          resizeMode="contain"
          accessible={false}
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
      </Pressable>
      <Modal
        testID="chat-image-fullscreen-modal"
        visible={viewerVisible}
        transparent
        animationType="fade"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => setViewerVisible(false)}
      >
        <View style={styles.imageViewerModalRoot}>
          <Pressable
            testID="chat-image-fullscreen-backdrop"
            style={StyleSheet.absoluteFill}
            onPress={() => setViewerVisible(false)}
          />
          <View style={styles.imageViewerHeader}>
            <View style={styles.imageViewerHintChip}>
              <Text style={styles.imageViewerHintText}>Pinch or double tap to zoom</Text>
            </View>
            <Pressable
              onPress={() => setViewerVisible(false)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.imageViewerCloseButton,
                pressed && styles.imageViewerCloseButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Close full-screen image"
            >
              <Ionicons name="close" size={20} color={theme.colors.textPrimary} />
            </Pressable>
          </View>
          <View style={styles.imageViewerStage}>
            <GestureDetector gesture={viewerGesture}>
              <Animated.Image
                source={source}
                style={[
                  styles.imageViewerImage,
                  modalImageAnimatedStyle,
                  {
                    width: viewerImageFrame.width,
                    height: viewerImageFrame.height,
                  },
                ]}
                resizeMode="contain"
                accessible={Boolean(accessibilityLabel)}
                accessibilityLabel={accessibilityLabel}
              />
            </GestureDetector>
          </View>
        </View>
      </Modal>
    </>
  );
}

function resolveContainedImageFrame(
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number | null
): { width: number; height: number } {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return {
      width: maxWidth,
      height: maxHeight,
    };
  }

  const widthFromHeight = maxHeight * aspectRatio;
  if (widthFromHeight <= maxWidth) {
    return {
      width: widthFromHeight,
      height: maxHeight,
    };
  }

  return {
    width: maxWidth,
    height: maxWidth / aspectRatio,
  };
}

function parseMessageBlocks(
  content: string,
  bridgeUrl: string | null,
  bridgeToken: string | null
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
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
    const inlineImage = toInlineImagePreviewFromMarkerLine(line, bridgeUrl, bridgeToken);
    if (inlineImage) {
      flushTextBlock();
      blocks.push({
        kind: 'image',
        source: inlineImage.source,
        accessibilityLabel: inlineImage.accessibilityLabel,
      });
      continue;
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

function toTimelineDetailPreview(
  entry: TimelineEntry | ToolGroupEntry,
  bridgeUrl: string | null,
  bridgeToken: string | null
): TimelineDetailPreview {
  const images: TimelineDetailMediaPreview[] = [];
  const textDetails: string[] = [];

  if (/^•\s*Viewed image\b/i.test(entry.title)) {
    const path = entry.details[0]?.trim();
    if (path) {
      const source = toMarkdownImageSource(path, bridgeUrl, bridgeToken);
      if (source) {
        images.push({
          source,
          accessibilityLabel: toPathBasename(path),
        });
      }
    }
  }

  for (const detail of entry.details) {
    const inlineImage = toInlineImagePreviewFromMarkerLine(
      detail,
      bridgeUrl,
      bridgeToken
    );
    if (inlineImage) {
      images.push(inlineImage);
      continue;
    }
    textDetails.push(detail);
  }

  return {
    textDetails,
    images,
  };
}

function toInlineImagePreviewFromMarkerLine(
  line: string,
  bridgeUrl: string | null,
  bridgeToken: string | null
): TimelineDetailMediaPreview | null {
  const normalizedLine = line.trim();

  const localImageMatch = normalizedLine.match(/^\[local image:\s*(.+?)\]$/i);
  if (localImageMatch) {
    const source = toMarkdownImageSource(localImageMatch[1], bridgeUrl, bridgeToken);
    if (!source) {
      return null;
    }

    return {
      source,
      accessibilityLabel: toPathBasename(localImageMatch[1]),
    };
  }

  const remoteImageMatch = normalizedLine.match(/^\[image:\s*(.+?)\]$/i);
  if (remoteImageMatch) {
    const source = toMarkdownImageSource(remoteImageMatch[1], bridgeUrl, bridgeToken);
    if (!source) {
      return null;
    }

    return {
      source,
      accessibilityLabel: toPathBasename(remoteImageMatch[1]),
    };
  }

  return null;
}

function isViewedImageEntry(title: string, textDetails: string[]): boolean {
  return /^•\s*Viewed image\b/i.test(title) && textDetails.length > 0;
}

function toPathBasename(path: string): string {
  const normalizedPath = path.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return 'image';
  }
  if (/^data:image\//i.test(normalizedPath)) {
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

function formatCompactionLabel(content: string): string {
  const normalized = content.replace(/^\s*[•-]\s*/, '').trim();
  if (!normalized) {
    return 'Conversation compacted';
  }

  if (/^compacted conversation context$/i.test(normalized)) {
    return 'Conversation compacted';
  }

  return normalized;
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
