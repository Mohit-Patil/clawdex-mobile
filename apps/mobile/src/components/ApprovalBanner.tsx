import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useState } from 'react';

import type { ApprovalDecision, PendingApproval } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface ApprovalBannerProps {
  approval: PendingApproval;
  onResolve: (id: string, decision: ApprovalDecision) => void;
}

export function ApprovalBanner({ approval, onResolve }: ApprovalBannerProps) {
  const [resolving, setResolving] = useState<ApprovalDecision | null>(null);

  const handleResolve = (decision: ApprovalDecision) => {
    setResolving(decision);
    onResolve(approval.id, decision);
  };

  const label = approval.kind === 'commandExecution'
    ? approval.command ?? 'Run command'
    : 'File change';

  const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

  return (
    <Animated.View entering={FadeInDown.duration(250)} style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.accent} />
        <Text style={styles.title}>Approval requested</Text>
      </View>

      <Text style={[styles.command, { fontFamily: monoFont }]} numberOfLines={3}>
        {label}
      </Text>

      {approval.reason ? (
        <Text style={styles.reason} numberOfLines={2}>{approval.reason}</Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.btn, styles.denyBtn, pressed && styles.btnPressed]}
          onPress={() => handleResolve('decline')}
          disabled={resolving !== null}
        >
          {resolving === 'decline' ? (
            <ActivityIndicator size="small" color={colors.error} />
          ) : (
            <>
              <Ionicons name="close" size={14} color={colors.error} />
              <Text style={[styles.btnText, { color: colors.error }]}>Deny</Text>
            </>
          )}
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.btn, styles.acceptBtn, pressed && styles.btnPressed]}
          onPress={() => handleResolve('accept')}
          disabled={resolving !== null}
        >
          {resolving === 'accept' ? (
            <ActivityIndicator size="small" color={colors.statusComplete} />
          ) : (
            <>
              <Ionicons name="checkmark" size={14} color={colors.statusComplete} />
              <Text style={[styles.btnText, { color: colors.statusComplete }]}>Accept</Text>
            </>
          )}
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: 'rgba(200, 169, 70, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(200, 169, 70, 0.3)',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.headline,
    color: colors.accent,
    fontSize: 13,
  },
  command: {
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  reason: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  btnPressed: {
    opacity: 0.7,
  },
  denyBtn: {
    borderColor: 'rgba(239, 68, 68, 0.3)',
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
  },
  acceptBtn: {
    borderColor: 'rgba(16, 185, 129, 0.3)',
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
  },
  btnText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
