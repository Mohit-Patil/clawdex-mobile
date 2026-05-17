import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';

import type {
  BridgeUiAction,
  BridgeUiBlock,
  BridgeUiSurface,
} from '../api/types';
import { useAppTheme, type AppTheme } from '../theme';
import { createWorkflowMarkdownStyles } from '../screens/mainScreenStyles';

interface BridgeUiSurfaceProps {
  surface: BridgeUiSurface;
  scrollMaxHeight?: number;
  onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
  onDismiss: (surface: BridgeUiSurface) => void;
}

export function BridgeUiWorkflowCard({
  surface,
  scrollMaxHeight = 320,
  onAction,
  onDismiss,
}: BridgeUiSurfaceProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <View style={[styles.surfaceCard, styles.workflowCard]}>
      <SurfaceHeader
        surface={surface}
        onDismiss={onDismiss}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />
      {collapsed ? null : (
        <>
          <ScrollView
            nestedScrollEnabled
            bounces={false}
            style={{ maxHeight: scrollMaxHeight }}
            contentContainerStyle={styles.surfaceBody}
            showsVerticalScrollIndicator
          >
            <SurfaceContent surface={surface} />
          </ScrollView>
          <SurfaceActions surface={surface} onAction={onAction} />
        </>
      )}
    </View>
  );
}

export function BridgeUiBanner({ surface, onAction, onDismiss }: BridgeUiSurfaceProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={[styles.surfaceCard, styles.bannerCard]}>
      <SurfaceHeader surface={surface} onDismiss={onDismiss} compact />
      <SurfaceContent surface={surface} compact />
      <SurfaceActions surface={surface} onAction={onAction} compact />
    </View>
  );
}

export function BridgeUiModal({
  surface,
  onAction,
  onDismiss,
}: BridgeUiSurfaceProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (surface.dismissible !== false) {
          onDismiss(surface);
        }
      }}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <SurfaceHeader surface={surface} onDismiss={onDismiss} />
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.surfaceBody}
            showsVerticalScrollIndicator={false}
          >
            <SurfaceContent surface={surface} />
          </ScrollView>
          <SurfaceActions surface={surface} onAction={onAction} />
        </View>
      </View>
    </Modal>
  );
}

function SurfaceHeader({
  surface,
  onDismiss,
  compact = false,
  collapsed,
  onToggleCollapse,
}: {
  surface: BridgeUiSurface;
  onDismiss: (surface: BridgeUiSurface) => void;
  compact?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const iconName = getSurfaceIconName(surface);
  const collapsible = typeof onToggleCollapse === 'function';
  const collapsedSummary = useMemo(() => getSurfaceCollapsedSummary(surface), [surface]);
  const headerContent = (
    <>
      <View style={styles.headerIcon}>
        <Ionicons name={iconName} size={15} color={getToneColor(theme, surface)} />
      </View>
      <View style={styles.headerCopy}>
        <Text style={styles.title}>{surface.title}</Text>
        {collapsed && collapsedSummary ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {collapsedSummary}
          </Text>
        ) : surface.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={compact ? 1 : 2}>
            {surface.subtitle}
          </Text>
        ) : null}
      </View>
    </>
  );

  if (collapsible) {
    return (
      <Pressable
        onPress={onToggleCollapse}
        style={({ pressed }) => [
          styles.header,
          styles.headerPressable,
          compact && styles.headerCompact,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? 'Expand surface' : 'Collapse surface'}
      >
        {headerContent}
        <Ionicons
          name={collapsed ? 'chevron-down-outline' : 'chevron-up-outline'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>
    );
  }

  return (
    <View style={[styles.header, compact && styles.headerCompact]}>
      {headerContent}
      {surface.dismissible === false ? null : (
        <Pressable
          onPress={() => onDismiss(surface)}
          hitSlop={8}
          style={({ pressed }) => [styles.dismissButton, pressed && styles.pressed]}
        >
          <Ionicons name="close" size={16} color={theme.colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

function SurfaceContent({
  surface,
  compact = false,
}: {
  surface: BridgeUiSurface;
  compact?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const markdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);

  return (
    <>
      {surface.bodyMarkdown ? (
        <Markdown style={markdownStyles}>{surface.bodyMarkdown}</Markdown>
      ) : null}
      {surface.blocks.map((block, index) => (
        <SurfaceBlock
          key={`${surface.id}-${String(index)}-${block.type}`}
          block={block}
          compact={compact}
        />
      ))}
      {!surface.bodyMarkdown && surface.blocks.length === 0 ? (
        <Text style={styles.emptyText}>No details provided.</Text>
      ) : null}
    </>
  );
}

function SurfaceBlock({ block, compact }: { block: BridgeUiBlock; compact?: boolean }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const markdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);

  switch (block.type) {
    case 'text':
      return <Text style={styles.bodyText}>{block.text}</Text>;
    case 'markdown':
      return <Markdown style={markdownStyles}>{block.markdown}</Markdown>;
    case 'checklist':
      return (
        <View style={styles.checklist}>
          {block.items.map((item, index) => (
            <View key={`${item.label}-${String(index)}`} style={styles.checklistRow}>
              <Text style={styles.checklistGlyph}>{getChecklistGlyph(item.status)}</Text>
              <View style={styles.checklistCopy}>
                <Text style={styles.bodyText}>{item.label}</Text>
                {item.detail ? <Text style={styles.detailText}>{item.detail}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      );
    case 'keyValue':
      return (
        <View style={[styles.keyValueGrid, compact && styles.keyValueGridCompact]}>
          {block.items.map((item) => (
            <View key={item.label} style={styles.keyValueRow}>
              <Text style={styles.keyLabel}>{item.label}</Text>
              <Text style={styles.keyValue}>{item.value}</Text>
            </View>
          ))}
        </View>
      );
    case 'code':
      return (
        <View style={styles.codeBlock}>
          {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
          <Text selectable style={styles.codeText}>
            {block.text}
          </Text>
        </View>
      );
    case 'progress': {
      const ratio = Math.max(0, Math.min(1, block.value / block.max));
      return (
        <View style={styles.progressBlock}>
          <View style={styles.progressHeader}>
            <Text style={styles.bodyText}>{block.label}</Text>
            <Text style={styles.detailText}>
              {`${formatNumber(block.value)} / ${formatNumber(block.max)}`}
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
          </View>
          {block.detail ? <Text style={styles.detailText}>{block.detail}</Text> : null}
        </View>
      );
    }
  }
}

function SurfaceActions({
  surface,
  onAction,
  compact = false,
}: {
  surface: BridgeUiSurface;
  onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
  compact?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (surface.actions.length === 0) {
    return null;
  }

  return (
    <View style={[styles.actions, compact && styles.actionsCompact]}>
      {surface.actions.map((action) => (
        <Pressable
          key={action.id}
          onPress={() => onAction(surface, action)}
          style={({ pressed }) => [
            styles.actionButton,
            action.style === 'primary' && styles.actionButtonPrimary,
            action.style === 'destructive' && styles.actionButtonDestructive,
            pressed && styles.pressed,
          ]}
        >
          <Text
            style={[
              styles.actionLabel,
              action.style === 'primary' && styles.actionLabelPrimary,
              action.style === 'destructive' && styles.actionLabelDestructive,
            ]}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function getChecklistGlyph(status: string | undefined): string {
  if (status === 'completed') {
    return '✓';
  }
  if (status === 'inProgress') {
    return '•';
  }
  return '○';
}

function getSurfaceIconName(
  surface: BridgeUiSurface
): keyof typeof Ionicons.glyphMap {
  if (surface.kind === 'goal') {
    return 'flag-outline';
  }
  if (surface.tone === 'warning') {
    return 'warning-outline';
  }
  if (surface.tone === 'error') {
    return 'alert-circle-outline';
  }
  if (surface.tone === 'success') {
    return 'checkmark-circle-outline';
  }
  return 'layers-outline';
}

function getToneColor(theme: AppTheme, surface: BridgeUiSurface): string {
  if (surface.tone === 'warning') {
    return theme.colors.warning;
  }
  if (surface.tone === 'error') {
    return theme.colors.error;
  }
  if (surface.tone === 'success') {
    return theme.colors.success;
  }
  return theme.colors.textPrimary;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function getSurfaceCollapsedSummary(surface: BridgeUiSurface): string {
  const bodySummary = normalizeCollapsedSummary(surface.bodyMarkdown ?? '');
  if (bodySummary) {
    return bodySummary;
  }

  for (const block of surface.blocks) {
    if (block.type === 'text') {
      const text = normalizeCollapsedSummary(block.text);
      if (text) {
        return text;
      }
    }
    if (block.type === 'markdown') {
      const text = normalizeCollapsedSummary(block.markdown);
      if (text) {
        return text;
      }
    }
    if (block.type === 'checklist') {
      const item = block.items.find((entry) => normalizeCollapsedSummary(entry.label));
      if (item) {
        return normalizeCollapsedSummary(item.label);
      }
    }
    if (block.type === 'progress') {
      return normalizeCollapsedSummary(block.label);
    }
    if (block.type === 'keyValue') {
      const item = block.items[0];
      if (item) {
        return normalizeCollapsedSummary(`${item.label}: ${item.value}`);
      }
    }
    if (block.type === 'code') {
      const text = normalizeCollapsedSummary(block.text);
      if (text) {
        return text;
      }
    }
  }

  return normalizeCollapsedSummary(surface.subtitle ?? '');
}

function normalizeCollapsedSummary(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~#>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    surfaceCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: 12,
      backgroundColor: theme.colors.bgItem,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    workflowCard: {
      boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.16)',
    },
    bannerCard: {
      marginBottom: theme.spacing.sm,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: theme.colors.overlayBackdrop,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    modalCard: {
      backgroundColor: theme.colors.bgItem,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.colors.borderHighlight,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      maxHeight: '80%',
    },
    modalScroll: {
      maxHeight: 420,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    headerCompact: {
      alignItems: 'center',
    },
    headerPressable: {
      borderRadius: 10,
    },
    headerIcon: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    headerCopy: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    title: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    subtitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    dismissButton: {
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    pressed: {
      opacity: 0.84,
    },
    surfaceBody: {
      gap: theme.spacing.sm,
      paddingBottom: theme.spacing.xs,
    },
    bodyText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      lineHeight: 18,
    },
    detailText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      lineHeight: 16,
    },
    emptyText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontStyle: 'italic',
    },
    checklist: {
      gap: theme.spacing.xs,
    },
    checklistRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    checklistGlyph: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      width: 16,
      marginTop: 1,
    },
    checklistCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    keyValueGrid: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: 10,
      overflow: 'hidden',
    },
    keyValueGridCompact: {
      marginTop: -theme.spacing.xs,
    },
    keyValueRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    keyLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      flex: 1,
    },
    keyValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      flex: 1,
      textAlign: 'right',
      fontWeight: '600',
    },
    codeBlock: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.inlineCodeBorder,
      borderRadius: 10,
      backgroundColor: theme.colors.inlineCodeBg,
      padding: theme.spacing.sm,
      gap: theme.spacing.xs,
    },
    codeLanguage: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0,
      fontSize: 10,
    },
    codeText: {
      ...theme.typography.mono,
      color: theme.colors.inlineCodeText,
      fontSize: 12,
      lineHeight: 17,
    },
    progressBlock: {
      gap: theme.spacing.xs,
    },
    progressHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    progressTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.colors.bgMain,
      overflow: 'hidden',
    },
    progressFill: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.colors.accent,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: theme.spacing.sm,
      flexWrap: 'wrap',
    },
    actionsCompact: {
      justifyContent: 'flex-start',
    },
    actionButton: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.bgMain,
      borderRadius: 10,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    actionButtonPrimary: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.accent,
    },
    actionButtonDestructive: {
      borderColor: theme.colors.error,
      backgroundColor: theme.colors.errorBg,
    },
    actionLabel: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    actionLabelPrimary: {
      color: theme.colors.accentText,
    },
    actionLabelDestructive: {
      color: theme.colors.error,
    },
  });
