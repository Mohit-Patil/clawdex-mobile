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
  const [resolving, setResolving] = useState<string | null>(null);

  const handleResolve = (decision: ApprovalDecision) => {
    setResolving(decisionKey(decision));
    onResolve(approval.id, decision);
  };

  const label = approval.kind === 'commandExecution'
    ? approval.command ?? 'Run command'
    : 'File change';
  const canAllowSimilar =
    approval.kind === 'commandExecution' &&
    Array.isArray(approval.proposedExecpolicyAmendment) &&
    approval.proposedExecpolicyAmendment.length > 0;

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
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <>
              <Ionicons name="checkmark" size={14} color={colors.textPrimary} />
              <Text style={[styles.btnText, { color: colors.textPrimary }]}>Allow once</Text>
            </>
          )}
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.btn, styles.acceptBtn, pressed && styles.btnPressed]}
          onPress={() => handleResolve('acceptForSession')}
          disabled={resolving !== null}
        >
          {resolving === 'acceptForSession' ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <>
              <Ionicons name="time-outline" size={14} color={colors.textPrimary} />
              <Text style={[styles.btnText, { color: colors.textPrimary }]}>Session</Text>
            </>
          )}
        </Pressable>

        {canAllowSimilar ? (
          <Pressable
            style={({ pressed }) => [
              styles.btn,
              styles.acceptBtn,
              styles.allowSimilarBtn,
              pressed && styles.btnPressed,
            ]}
            onPress={() =>
              handleResolve({
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: approval.proposedExecpolicyAmendment ?? [],
                },
              })
            }
            disabled={resolving !== null}
          >
            {resolving === 'acceptWithExecpolicyAmendment' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <>
                <Ionicons name="flash-outline" size={14} color={colors.textPrimary} />
                <Text style={[styles.btnText, { color: colors.textPrimary }]}>Allow similar</Text>
              </>
            )}
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

function decisionKey(decision: ApprovalDecision): string {
  if (typeof decision === 'string') {
    return decision;
  }

  if ('acceptWithExecpolicyAmendment' in decision) {
    return 'acceptWithExecpolicyAmendment';
  }

  return 'unknown';
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgItem,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
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
    backgroundColor: colors.bgItem,
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
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  btn: {
    flexGrow: 1,
    minWidth: 112,
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
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgInput,
  },
  allowSimilarBtn: {
    flexBasis: '100%',
  },
  btnText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
