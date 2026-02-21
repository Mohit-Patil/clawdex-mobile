import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputKeyPressEventData,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../theme';

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onNewThread: () => void;
  isLoading: boolean;
  placeholder?: string;
}

export function ChatInput({
  value,
  onChangeText,
  onSubmit,
  onNewThread,
  isLoading,
  placeholder = 'Message Codex...',
}: ChatInputProps) {
  const canSend = value.trim().length > 0 && !isLoading;

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onNewThread}
        style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed]}
      >
        <Ionicons name="add" size={20} color={colors.textMuted} />
      </Pressable>

      <View style={styles.inputWrapper}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          multiline
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
        {canSend || isLoading ? (
          <Pressable
            onPress={canSend ? onSubmit : undefined}
            style={styles.sendBtn}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Ionicons name="arrow-up" size={14} color={colors.textPrimary} />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.lg : spacing.md,
    backgroundColor: colors.bgMain,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
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
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
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
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
});
