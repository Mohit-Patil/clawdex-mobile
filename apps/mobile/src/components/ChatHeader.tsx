import { Ionicons } from '@expo/vector-icons';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../theme';

interface ChatHeaderProps {
  onOpenDrawer: () => void;
  modelName?: string;
}

export function ChatHeader({ onOpenDrawer, modelName = 'Codex' }: ChatHeaderProps) {
  return (
    <View style={styles.headerContainer}>
      <SafeAreaView>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <View style={styles.modelNameRow}>
            <Text style={styles.modelName}>{modelName}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </View>
          <View style={{ flex: 1 }} />
          <Ionicons name="sparkles-outline" size={20} color={colors.textMuted} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
    zIndex: 10,
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
  },
  modelName: {
    ...typography.largeTitle,
    fontSize: 20,
    color: colors.textPrimary,
  },
});
