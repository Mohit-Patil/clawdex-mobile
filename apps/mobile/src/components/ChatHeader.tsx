import { Ionicons } from '@expo/vector-icons';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../theme';

interface ChatHeaderProps {
  onOpenDrawer: () => void;
  title: string;
  onOpenTitleMenu?: () => void;
}

export function ChatHeader({ onOpenDrawer, title, onOpenTitleMenu }: ChatHeaderProps) {
  const titleDisplay = title.trim() || 'New chat';

  return (
    <View style={styles.headerContainer}>
      <SafeAreaView>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          {onOpenTitleMenu ? (
            <Pressable
              onPress={onOpenTitleMenu}
              hitSlop={8}
              style={({ pressed }) => [styles.titleButton, pressed && styles.titleButtonPressed]}
            >
              <Text numberOfLines={1} style={styles.modelName}>
                {titleDisplay}
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </Pressable>
          ) : (
            <View style={styles.modelNameRow}>
              <Text numberOfLines={1} style={styles.modelName}>
                {titleDisplay}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          <Ionicons name="sparkles-outline" size={20} color={colors.textMuted} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  menuBtn: {
    padding: spacing.xs,
  },
  modelNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  titleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: 8,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    flexShrink: 1,
  },
  titleButtonPressed: {
    backgroundColor: colors.bgItem,
  },
  modelName: {
    ...typography.largeTitle,
    fontSize: 20,
    color: colors.textPrimary,
    flexShrink: 1,
  },
});
