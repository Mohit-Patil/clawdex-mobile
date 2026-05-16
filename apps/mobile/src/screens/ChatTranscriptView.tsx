import { Ionicons } from '@expo/vector-icons';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Text,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
} from 'react-native';

import type { Chat } from '../api/types';
import { ChatMessage, ToolActivityGroup } from '../components/ChatMessage';
import { useAppTheme } from '../theme';
import {
  type AutoScrollState,
  CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX,
  CHAT_MESSAGE_PAGE_SIZE,
  LARGE_CHAT_MESSAGE_COUNT_THRESHOLD,
  filterReasoningMessagesForEngine,
  findInlineChoiceSet,
  getInitialVisibleMessageStartIndex,
} from './mainScreenHelpers';
import { createStyles } from './mainScreenStyles';
import { trimInheritedParentMessages } from './subAgentTranscript';
import {
  buildTranscriptDisplayItems,
  getVisibleTranscriptMessages,
  syncVisibleSubAgentStatuses,
  type TranscriptDisplayItem,
} from './transcriptMessages';

export interface ChatTranscriptViewProps {
  chat: Chat;
  parentChat: Chat | null;
  bridgeUrl: string;
  bridgeToken: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
  showToolCalls: boolean;
  agentThreadStatusById: ReadonlyMap<string, Chat['status']>;
  scrollRef: React.RefObject<FlatList<TranscriptDisplayItem> | null>;
  inlineChoicesEnabled: boolean;
  onInlineOptionSelect: (value: string) => void;
  onPinnedAutoScroll: (animated?: boolean) => void;
  onJumpToLatest: () => void;
  onScrollInteractionStart: () => void;
  autoScrollStateRef: React.MutableRefObject<AutoScrollState>;
  bottomInset: number;
}

export const ChatTranscriptView = memo(function ChatTranscriptView({
  chat,
  parentChat,
  bridgeUrl,
  bridgeToken,
  onOpenLocalPreview,
  showToolCalls,
  agentThreadStatusById,
  scrollRef,
  inlineChoicesEnabled,
  onInlineOptionSelect,
  onPinnedAutoScroll,
  onJumpToLatest,
  onScrollInteractionStart,
  autoScrollStateRef,
  bottomInset,
}: ChatTranscriptViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const showJumpToLatestRef = useRef(false);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const scrollOffsetYRef = useRef(0);
  const previousScrollOffsetYRef = useRef(0);
  const scrollingTowardOlderMessagesRef = useRef(false);
  const autoLoadOlderCheckpointRef = useRef<number | null>(null);
  const visibleMessageCountRef = useRef(0);

  const transcriptView = useMemo(() => {
    const childVisibleMessages = getVisibleTranscriptMessages(
      filterReasoningMessagesForEngine(chat.messages, chat.engine),
      showToolCalls
    );
    if (!chat.parentThreadId || !parentChat) {
      return {
        messages: childVisibleMessages,
        hiddenInheritedMessageCount: 0,
      };
    }

    const parentVisibleMessages = getVisibleTranscriptMessages(
      filterReasoningMessagesForEngine(parentChat.messages, parentChat.engine),
      showToolCalls
    );
    return trimInheritedParentMessages(parentVisibleMessages, childVisibleMessages, chat.id);
  }, [chat.messages, chat.parentThreadId, parentChat, showToolCalls]);
  const visibleMessages = useMemo(
    () => syncVisibleSubAgentStatuses(transcriptView.messages, agentThreadStatusById),
    [agentThreadStatusById, transcriptView.messages]
  );
  const [visibleStartIndex, setVisibleStartIndex] = useState(() =>
    getInitialVisibleMessageStartIndex(visibleMessages.length)
  );
  const paginatedMessages = useMemo(
    () => visibleMessages.slice(visibleStartIndex),
    [visibleMessages, visibleStartIndex]
  );
  const paginatedTranscriptItems = useMemo(
    () => buildTranscriptDisplayItems(paginatedMessages),
    [paginatedMessages]
  );
  const displayMessages = useMemo(
    () => [...paginatedTranscriptItems].reverse(),
    [paginatedTranscriptItems]
  );
  const inlineChoiceSet = useMemo(
    () => (inlineChoicesEnabled ? findInlineChoiceSet(paginatedMessages) : null),
    [inlineChoicesEnabled, paginatedMessages]
  );
  useEffect(() => {
    visibleMessageCountRef.current = visibleMessages.length;
  }, [visibleMessages.length]);

  useEffect(() => {
    setVisibleStartIndex(getInitialVisibleMessageStartIndex(visibleMessageCountRef.current));
  }, [chat.id, showToolCalls]);

  useEffect(() => {
    setVisibleStartIndex((current) => {
      const maxStartIndex = getInitialVisibleMessageStartIndex(visibleMessages.length);
      return current > maxStartIndex ? maxStartIndex : current;
    });
  }, [visibleMessages.length]);

  const loadOlderMessages = useCallback(() => {
    setVisibleStartIndex((current) =>
      Math.max(0, current - CHAT_MESSAGE_PAGE_SIZE)
    );
  }, []);

  const maybeAutoLoadOlderMessages = useCallback(
    (allowShortContentLoad = false) => {
      if (visibleStartIndex <= 0) {
        return;
      }

      const viewportHeight = viewportHeightRef.current;
      if (viewportHeight <= 0) {
        return;
      }

      const maxOffsetY = Math.max(contentHeightRef.current - viewportHeight, 0);
      const distanceFromOlderEdge = Math.max(0, maxOffsetY - scrollOffsetYRef.current);
      const contentNeedsMoreToScroll = maxOffsetY <= CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX;
      const reachedOlderEdge = distanceFromOlderEdge <= CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX;
      if (!contentNeedsMoreToScroll && !reachedOlderEdge) {
        return;
      }

      if (
        !scrollingTowardOlderMessagesRef.current &&
        !(allowShortContentLoad && contentNeedsMoreToScroll)
      ) {
        return;
      }

      if (autoLoadOlderCheckpointRef.current === visibleStartIndex) {
        return;
      }

      autoLoadOlderCheckpointRef.current = visibleStartIndex;
      loadOlderMessages();
    },
    [loadOlderMessages, visibleStartIndex]
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const nextOffsetY = Math.max(contentOffset.y, 0);
      contentHeightRef.current = contentSize.height;
      viewportHeightRef.current = layoutMeasurement.height;
      scrollOffsetYRef.current = nextOffsetY;
      scrollingTowardOlderMessagesRef.current =
        nextOffsetY > previousScrollOffsetYRef.current + 1;
      previousScrollOffsetYRef.current = nextOffsetY;

      const distanceFromBottom = contentOffset.y;
      const shouldStickToBottom = distanceFromBottom <= theme.spacing.xl * 2;
      autoScrollStateRef.current.shouldStickToBottom = shouldStickToBottom;
      const nextShowJumpToLatest = !shouldStickToBottom;
      if (showJumpToLatestRef.current !== nextShowJumpToLatest) {
        showJumpToLatestRef.current = nextShowJumpToLatest;
        setShowJumpToLatest(nextShowJumpToLatest);
      }
      maybeAutoLoadOlderMessages(false);
    },
    [autoScrollStateRef, maybeAutoLoadOlderMessages, theme.spacing.xl]
  );

  useEffect(() => {
    autoScrollStateRef.current.shouldStickToBottom = true;
    autoScrollStateRef.current.isUserInteracting = false;
    autoScrollStateRef.current.isMomentumScrolling = false;
    showJumpToLatestRef.current = false;
    setShowJumpToLatest(false);
    contentHeightRef.current = 0;
    viewportHeightRef.current = 0;
    scrollOffsetYRef.current = 0;
    previousScrollOffsetYRef.current = 0;
    scrollingTowardOlderMessagesRef.current = false;
    autoLoadOlderCheckpointRef.current = null;
  }, [autoScrollStateRef, chat.id]);
  const messageListContentStyle = useMemo(
    () =>
      Platform.OS === 'android'
        ? [styles.messageListContent, { paddingTop: bottomInset }]
        : [styles.messageListContent, { paddingBottom: bottomInset }],
    [bottomInset, styles.messageListContent]
  );
  const liveTurnActive = chat.status === 'running';
  const isLargeChat = visibleMessages.length >= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD;
  const keyExtractor = useCallback(
    (item: TranscriptDisplayItem) => (item.kind === 'message' ? item.renderKey : item.id),
    []
  );
  const renderMessageItem = useCallback<ListRenderItem<TranscriptDisplayItem>>(
    ({ item }) => {
      if (item.kind === 'toolGroup') {
        return (
          <View style={styles.chatMessageBlock}>
            <ToolActivityGroup
              messages={item.messages}
              engine={chat.engine}
              bridgeUrl={bridgeUrl}
              bridgeToken={bridgeToken}
              liveTurnActive={liveTurnActive}
            />
          </View>
        );
      }

      const msg = item.message;
      const showInlineChoices = inlineChoiceSet?.messageId === msg.id;
      return (
        <View style={styles.chatMessageBlock}>
          <ChatMessage
            message={msg}
            engine={chat.engine}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            onOpenLocalPreview={onOpenLocalPreview}
          />
          {showInlineChoices ? (
            <View style={styles.inlineChoiceOptions}>
              {inlineChoiceSet.options.map((option, index) => (
                <Pressable
                  key={`${msg.id}-${index}-${option.label}`}
                  style={({ pressed }) => [
                    styles.inlineChoiceOptionButton,
                    pressed && styles.inlineChoiceOptionButtonPressed,
                  ]}
                  onPress={() => onInlineOptionSelect(option.label)}
                >
                  <View style={styles.inlineChoiceOptionRow}>
                    <Text style={styles.inlineChoiceOptionIndex}>{`${String(index + 1)}.`}</Text>
                    <Text style={styles.inlineChoiceOptionLabel}>{option.label}</Text>
                  </View>
                  {option.description.trim() ? (
                    <Text style={styles.inlineChoiceOptionDescription}>
                      {option.description}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              <Text style={styles.inlineChoiceHint}>
                Tap an option to fill the reply box.
              </Text>
            </View>
          ) : null}
        </View>
      );
    },
    [
      bridgeToken,
      bridgeUrl,
      chat.engine,
      chat.status,
      inlineChoiceSet,
      liveTurnActive,
      onInlineOptionSelect,
      onOpenLocalPreview,
    ]
  );

  return (
    <View style={styles.messageListShell}>
      <FlatList
        key={chat.id}
        ref={scrollRef}
        data={displayMessages}
        extraData={chat.status}
        keyExtractor={keyExtractor}
        renderItem={renderMessageItem}
        style={styles.messageList}
        contentContainerStyle={messageListContentStyle}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        inverted
        showsVerticalScrollIndicator={false}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          onScrollInteractionStart();
          Keyboard.dismiss();
          autoScrollStateRef.current.isUserInteracting = true;
          autoScrollStateRef.current.isMomentumScrolling = false;
          autoScrollStateRef.current.shouldStickToBottom = false;
        }}
        onScrollEndDrag={() => {
          if (!autoScrollStateRef.current.isMomentumScrolling) {
            autoScrollStateRef.current.isUserInteracting = false;
          }
        }}
        onMomentumScrollBegin={() => {
          autoScrollStateRef.current.isMomentumScrolling = true;
        }}
        onMomentumScrollEnd={() => {
          autoScrollStateRef.current.isUserInteracting = false;
          autoScrollStateRef.current.isMomentumScrolling = false;
        }}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onLayout={(event) => {
          viewportHeightRef.current = event.nativeEvent.layout.height;
          maybeAutoLoadOlderMessages(true);
        }}
        onContentSizeChange={(_width, height) => {
          contentHeightRef.current = height;
          onPinnedAutoScroll(false);
          maybeAutoLoadOlderMessages(true);
        }}
        initialNumToRender={Math.min(displayMessages.length, isLargeChat ? 18 : 16)}
        maxToRenderPerBatch={Math.min(displayMessages.length, isLargeChat ? 12 : 10)}
        updateCellsBatchingPeriod={isLargeChat ? 32 : undefined}
        windowSize={isLargeChat ? 13 : 11}
        removeClippedSubviews={false}
      />
      {showJumpToLatest ? (
        <Pressable
          onPress={() => {
            autoScrollStateRef.current.shouldStickToBottom = true;
            autoScrollStateRef.current.isUserInteracting = false;
            autoScrollStateRef.current.isMomentumScrolling = false;
            showJumpToLatestRef.current = false;
            setShowJumpToLatest(false);
            onJumpToLatest();
          }}
          style={({ pressed }) => [
            styles.jumpToLatestButton,
            { bottom: bottomInset + theme.spacing.xs },
            pressed && styles.jumpToLatestButtonPressed,
          ]}
        >
          <Ionicons
            name="arrow-down"
            size={14}
            color={theme.colors.textPrimary}
          />
        </Pressable>
      ) : null}
    </View>
  );
}, areChatTranscriptViewPropsEqual);

function areChatTranscriptViewPropsEqual(previous: ChatTranscriptViewProps, next: ChatTranscriptViewProps): boolean {
  return (
    areChatsEquivalentForTranscript(previous.chat, next.chat) &&
    areChatsEquivalentForTranscript(previous.parentChat, next.parentChat) &&
    previous.bridgeUrl === next.bridgeUrl &&
    previous.bridgeToken === next.bridgeToken &&
    previous.onOpenLocalPreview === next.onOpenLocalPreview &&
    previous.showToolCalls === next.showToolCalls &&
    previous.agentThreadStatusById === next.agentThreadStatusById &&
    previous.scrollRef === next.scrollRef &&
    previous.inlineChoicesEnabled === next.inlineChoicesEnabled &&
    previous.onInlineOptionSelect === next.onInlineOptionSelect &&
    previous.onPinnedAutoScroll === next.onPinnedAutoScroll &&
    previous.onJumpToLatest === next.onJumpToLatest &&
    previous.onScrollInteractionStart === next.onScrollInteractionStart &&
    previous.autoScrollStateRef === next.autoScrollStateRef &&
    previous.bottomInset === next.bottomInset
  );
}

function areChatsEquivalentForTranscript(
  previous: Chat | null,
  next: Chat | null
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    previous.id === next.id &&
    previous.parentThreadId === next.parentThreadId &&
    previous.engine === next.engine &&
    previous.status === next.status &&
    previous.messages === next.messages
  );
}
