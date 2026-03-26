import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BrandMark } from './BrandMark';
import { colors, spacing, typography } from '../theme';

interface ChatHeaderProps {
  onOpenDrawer: () => void;
  title: string;
  engineLabel?: string;
  onOpenTitleMenu?: () => void;
  rightIconName?: keyof typeof Ionicons.glyphMap;
  onRightActionPress?: () => void;
}

export function ChatHeader({
  onOpenDrawer,
  title,
  engineLabel,
  onOpenTitleMenu,
  rightIconName = 'sparkles-outline',
  onRightActionPress,
}: ChatHeaderProps) {
  const titleDisplay = title.trim() || 'New chat';

  return (
    <View style={styles.headerContainer}>
      <SafeAreaView edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={20} color={colors.textPrimary} />
          </Pressable>
          <BrandMark size={18} />
          {onOpenTitleMenu ? (
            <Pressable
              onPress={onOpenTitleMenu}
              hitSlop={8}
              style={({ pressed }) => [styles.titleButton, pressed && styles.titleButtonPressed]}
            >
              <Text numberOfLines={1} style={styles.modelName}>
                {titleDisplay}
              </Text>
              {engineLabel ? (
                <View style={styles.engineBadge}>
                  <Text style={styles.engineBadgeText}>{engineLabel}</Text>
                </View>
              ) : null}
              <Ionicons name="chevron-down" size={12} color={colors.textMuted} />
            </Pressable>
          ) : (
            <View style={styles.modelNameRow}>
              <Text numberOfLines={1} style={styles.modelName}>
                {titleDisplay}
              </Text>
              {engineLabel ? (
                <View style={styles.engineBadge}>
                  <Text style={styles.engineBadgeText}>{engineLabel}</Text>
                </View>
              ) : null}
            </View>
          )}
          <View style={{ flex: 1 }} />
          {onRightActionPress ? (
            <Pressable onPress={onRightActionPress} hitSlop={8} style={styles.rightBtn}>
              <Ionicons name={rightIconName} size={18} color={colors.textMuted} />
            </Pressable>
          ) : (
            <Ionicons name={rightIconName} size={18} color={colors.textMuted} />
          )}
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
    paddingVertical: spacing.sm,
  },
  menuBtn: {
    padding: 2,
  },
  rightBtn: {
    padding: 2,
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
    paddingHorizontal: 2,
    paddingVertical: 1,
    flexShrink: 1,
  },
  titleButtonPressed: {
    backgroundColor: colors.bgItem,
  },
  modelName: {
    ...typography.headline,
    fontSize: 17,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  engineBadge: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
  },
  engineBadgeText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
});
