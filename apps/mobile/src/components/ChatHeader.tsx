import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme, type AppTheme } from '../theme';

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
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const titleDisplay = title.trim() || 'New chat';

  return (
    <View style={styles.headerContainer}>
      <SafeAreaView edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={20} color={colors.textPrimary} />
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

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    headerContainer: {
      backgroundColor: theme.colors.bgMain,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
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
      gap: theme.spacing.xs,
      flexShrink: 1,
    },
    titleButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderRadius: 8,
      paddingHorizontal: 2,
      paddingVertical: 1,
      flexShrink: 1,
    },
    titleButtonPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    modelName: {
      ...theme.typography.headline,
      fontSize: 17,
      color: theme.colors.textPrimary,
      flexShrink: 1,
    },
    engineBadge: {
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.isDark ? theme.colors.borderHighlight : theme.colors.border,
      backgroundColor: theme.isDark ? theme.colors.bgItem : theme.colors.bgInput,
      paddingHorizontal: theme.spacing.xs + 2,
      paddingVertical: 2,
    },
    engineBadgeText: {
      ...theme.typography.caption,
      color: theme.isDark ? theme.colors.textSecondary : theme.colors.textPrimary,
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.3,
      textTransform: 'uppercase',
    },
  });
