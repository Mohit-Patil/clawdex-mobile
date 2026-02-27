import { Ionicons } from '@expo/vector-icons';
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
}: ChatInputProps) {
  const INPUT_TEXT_MIN_HEIGHT = 20;
  const INPUT_TEXT_MAX_HEIGHT = 96;
  const [inputHeight, setInputHeight] = useState(INPUT_TEXT_MIN_HEIGHT);

  useEffect(() => {
    if (!value && inputHeight !== INPUT_TEXT_MIN_HEIGHT) {
      setInputHeight(INPUT_TEXT_MIN_HEIGHT);
    }
  }, [inputHeight, value]);

  const canSend = value.trim().length > 0 && !isLoading;
  const canStop = Boolean(showStopButton && onStop);
  const showVoiceButton =
    !canSend && !canStop && !isLoading && voiceState !== 'transcribing' && Boolean(onVoiceToggle);
  const shouldShowActionButton = canStop || canSend || isLoading || showVoiceButton || voiceState !== 'idle';

  return (
    <View style={styles.container}>
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
          <TextInput
            style={[styles.input, { height: inputHeight }]}
            value={value}
            onChangeText={onChangeText}
            onFocus={onFocus}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            multiline
            onContentSizeChange={(event) => {
              const nextHeight = Math.max(
                INPUT_TEXT_MIN_HEIGHT,
                Math.min(INPUT_TEXT_MAX_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height))
              );
              if (nextHeight !== inputHeight) {
                setInputHeight(nextHeight);
              }
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
            ) : showVoiceButton ? (
              <Pressable
                onPress={onVoiceToggle}
                style={styles.sendBtn}
              >
                <Ionicons name="mic-outline" size={14} color={colors.textMuted} />
              </Pressable>
            ) : (
              <Pressable
                onPress={canStop ? onStop : canSend ? onSubmit : undefined}
                style={styles.sendBtn}
                disabled={canStop ? isStopping : !canSend}
              >
                {canStop ? (
                  <View style={styles.stopButtonContent}>
                    <Ionicons name="square" size={10} color={colors.textPrimary} />
                    <ActivityIndicator
                      size="small"
                      color={colors.textMuted}
                      style={styles.stopButtonSpinner}
                    />
                  </View>
                ) : isLoading ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Ionicons name="arrow-up" size={14} color={colors.textPrimary} />
                )}
              </Pressable>
            )
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.lg : spacing.md,
    backgroundColor: colors.bgMain,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
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
    textAlignVertical: 'center',
  },
  sendBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
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
