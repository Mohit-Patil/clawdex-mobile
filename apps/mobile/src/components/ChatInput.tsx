import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextLayoutEventData,
  type TextInputKeyPressEventData,
  View,
} from 'react-native';

import type { VoiceState } from '../hooks/useVoiceRecorder';
import { colors, radius, spacing } from '../theme';

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachPress: () => void;
  attachments?: Array<{ id: string; label: string }>;
  onRemoveAttachment?: (id: string) => void;
  isLoading: boolean;
  showStopButton?: boolean;
  isStopping?: boolean;
  placeholder?: string;
  onVoiceToggle?: () => void;
  voiceState?: VoiceState;
  safeAreaBottomInset?: number;
  keyboardVisible?: boolean;
}

export function ChatInput({
  value,
  onChangeText,
  onFocus,
  onSubmit,
  onStop,
  onAttachPress,
  attachments = [],
  onRemoveAttachment,
  isLoading,
  showStopButton = false,
  isStopping = false,
  placeholder = 'Message Codex...',
  onVoiceToggle,
  voiceState = 'idle',
  safeAreaBottomInset = 0,
  keyboardVisible = false,
}: ChatInputProps) {
  const INPUT_TEXT_LINE_HEIGHT = 20;
  const INPUT_TEXT_VERTICAL_PADDING = Platform.OS === 'ios' ? 2 : 0;
  const INPUT_TEXT_MIN_HEIGHT = 20;
  const INPUT_TEXT_MAX_HEIGHT = 96;
  const [inputHeight, setInputHeight] = useState(INPUT_TEXT_MIN_HEIGHT);
  const [inputWidth, setInputWidth] = useState(0);
  const updateInputHeight = (height: number) => {
    const nextHeight = Math.max(
      INPUT_TEXT_MIN_HEIGHT,
      Math.min(INPUT_TEXT_MAX_HEIGHT, Math.ceil(height))
    );
    setInputHeight((previousHeight) =>
      previousHeight === nextHeight ? previousHeight : nextHeight
    );
  };

  useEffect(() => {
    if (!value && inputHeight !== INPUT_TEXT_MIN_HEIGHT) {
      setInputHeight(INPUT_TEXT_MIN_HEIGHT);
    }
  }, [inputHeight, value]);

  const canSend = value.trim().length > 0 && voiceState === 'idle';
  const canStop = Boolean(showStopButton && onStop);
  const showVoiceButton = Boolean(onVoiceToggle);
  const showSendButton = canSend || isLoading;
  const inputScrollEnabled = inputHeight >= INPUT_TEXT_MAX_HEIGHT;
  const shouldShowActionButton =
    canStop || showSendButton || showVoiceButton || voiceState !== 'idle';
  const baseBottomPadding =
    Platform.OS === 'ios'
      ? keyboardVisible
        ? spacing.sm
        : spacing.lg
      : spacing.md;
  const extraBottomInset = keyboardVisible ? 0 : safeAreaBottomInset;

  return (
    <View style={styles.shell}>
      <BlurView
        intensity={26}
        tint={Platform.OS === 'ios' ? 'systemUltraThinMaterialDark' : 'dark'}
        blurMethod="dimezisBlurViewSdk31Plus"
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          styles.container,
          {
            paddingBottom:
              baseBottomPadding + extraBottomInset,
          },
        ]}
      >
        {attachments.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.attachmentListContent}
            style={styles.attachmentList}
          >
            {attachments.map((attachment, index) => (
              <Pressable
                key={`${attachment.id}-${String(index)}`}
                onPress={
                  onRemoveAttachment
                    ? () => onRemoveAttachment(attachment.id)
                    : undefined
                }
                style={({ pressed }) => [
                  styles.attachmentChip,
                  pressed && styles.attachmentChipPressed,
                ]}
              >
                <Ionicons name="attach-outline" size={12} color={colors.textMuted} />
                <Text style={styles.attachmentChipText} numberOfLines={1}>
                  {attachment.label}
                </Text>
                {onRemoveAttachment ? (
                  <Ionicons name="close-outline" size={12} color={colors.textMuted} />
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.row}>
          <Pressable
            onPress={onAttachPress}
            style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed]}
          >
            <Ionicons name="add" size={20} color={colors.textMuted} />
          </Pressable>

          <View style={styles.inputWrapper}>
            <Text
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[
                styles.inputMeasure,
                {
                  width: inputWidth,
                  lineHeight: INPUT_TEXT_LINE_HEIGHT,
                  paddingVertical: INPUT_TEXT_VERTICAL_PADDING,
                },
              ]}
              onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) => {
                if (inputWidth <= 0) {
                  return;
                }
                const lineCount = Math.max(1, event.nativeEvent.lines.length);
                const measuredHeight =
                  lineCount * INPUT_TEXT_LINE_HEIGHT + INPUT_TEXT_VERTICAL_PADDING * 2;
                updateInputHeight(measuredHeight);
              }}
            >
              {value.length > 0 ? `${value}\u200b` : ' '}
            </Text>
            <TextInput
              style={[styles.input, { height: inputHeight }]}
              value={value}
              onChangeText={onChangeText}
              onLayout={(event) => {
                const nextWidth = Math.floor(event.nativeEvent.layout.width);
                setInputWidth((previousWidth) =>
                  previousWidth === nextWidth ? previousWidth : nextWidth
                );
              }}
              onChange={(event: NativeSyntheticEvent<unknown>) => {
                const nativeEvent = event.nativeEvent as {
                  contentSize?: { height?: number };
                };
                const contentHeight = nativeEvent.contentSize?.height;
                if (typeof contentHeight === 'number' && Number.isFinite(contentHeight)) {
                  updateInputHeight(contentHeight);
                }
              }}
              onFocus={onFocus}
              placeholder={placeholder}
              placeholderTextColor={colors.textMuted}
              multiline
              scrollEnabled={inputScrollEnabled}
              onContentSizeChange={(event) => {
                updateInputHeight(event.nativeEvent.contentSize.height);
              }}
              onKeyPress={(e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
                const keyEvent = e.nativeEvent as TextInputKeyPressEventData & {
                  shiftKey?: boolean;
                };
                if (
                  Platform.OS === 'web' &&
                  keyEvent.key === 'Enter' &&
                  !keyEvent.shiftKey
                ) {
                  e.preventDefault();
                  if (canSend) onSubmit();
                }
              }}
            />
            {shouldShowActionButton ? (
              <View style={styles.actionButtons}>
                {showVoiceButton || voiceState !== 'idle' ? (
                  voiceState === 'transcribing' ? (
                    <View style={styles.sendBtn}>
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    </View>
                  ) : voiceState === 'recording' ? (
                    <Pressable
                      onPress={onVoiceToggle}
                      style={[styles.sendBtn, styles.micBtnRecording]}
                    >
                      <Ionicons name="mic" size={14} color={colors.error} />
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={onVoiceToggle}
                      style={styles.sendBtn}
                    >
                      <Ionicons name="mic-outline" size={14} color={colors.textMuted} />
                    </Pressable>
                  )
                ) : null}
                {canStop ? (
                  <Pressable
                    onPress={onStop}
                    style={styles.sendBtn}
                    disabled={isStopping}
                  >
                    <View style={styles.stopButtonContent}>
                      <Ionicons name="square" size={10} color={colors.textPrimary} />
                      <ActivityIndicator
                        size="small"
                        color={colors.textMuted}
                        style={styles.stopButtonSpinner}
                      />
                    </View>
                  </Pressable>
                ) : null}
                {showSendButton ? (
                  <Pressable
                    onPress={canSend ? onSubmit : undefined}
                    style={styles.sendBtn}
                    disabled={!canSend}
                  >
                    {isLoading && !canSend ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Ionicons name="arrow-up" size={14} color={colors.textPrimary} />
                    )}
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    overflow: 'hidden',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  container: {
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: 'rgba(6, 9, 13, 0.42)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  attachmentList: {
    maxHeight: 34,
  },
  attachmentListContent: {
    gap: spacing.xs,
    paddingRight: spacing.sm,
  },
  attachmentChip: {
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgInput,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    maxWidth: 260,
  },
  attachmentChipPressed: {
    backgroundColor: colors.bgItem,
  },
  attachmentChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  plusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusBtnPressed: {
    backgroundColor: colors.bgItem,
  },
  inputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 40,
    maxHeight: 120,
  },
  input: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: Platform.OS === 'ios' ? 2 : 0,
    textAlignVertical: 'top',
  },
  inputMeasure: {
    position: 'absolute',
    opacity: 0,
    color: colors.textPrimary,
    fontSize: 14,
    left: spacing.md,
    top: spacing.xs,
  },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.xs,
    gap: spacing.xs,
  },
  sendBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnRecording: {
    borderWidth: 1.5,
    borderColor: colors.error,
  },
  stopButtonContent: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButtonSpinner: {
    position: 'absolute',
  },
});
