import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { MacBridgeApiClient } from '../api/client';
import type { BridgeWsEvent, ThreadSummary } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, spacing, typography } from '../theme';

type Screen = 'Main' | 'Terminal' | 'Git' | 'Settings' | 'Privacy' | 'Terms';

interface DrawerContentProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onNavigate: (screen: Screen) => void;
}

export function DrawerContent({
  api,
  ws,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onNavigate,
}: DrawerContentProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadThreads = useCallback(async () => {
    try {
      const data = await api.listThreads();
      setThreads(sortThreads(data));
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    return ws.onEvent((event: BridgeWsEvent) => {
      if (event.type === 'thread.created' || event.type === 'thread.updated') {
        setThreads((prev) => upsertThread(prev, event.payload));
      }
      if (event.type === 'thread.message.delta') {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === event.payload.threadId
              ? {
                ...t,
                lastMessagePreview: event.payload.content,
                updatedAt: event.payload.updatedAt,
              }
              : t
          )
        );
      }
    });
  }, [ws]);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        {/* New Thread button */}
        <View style={styles.header}>
          <Pressable
            style={({ pressed }) => [styles.newThreadBtn, pressed && styles.newThreadBtnPressed]}
            onPress={onNewThread}
          >
            <Ionicons name="add" size={16} color={colors.white} />
            <Text style={styles.newThreadText}>New thread</Text>
          </Pressable>
        </View>

        {/* Nav items */}
        <NavItem icon="terminal-outline" label="Terminal" onPress={() => onNavigate('Terminal')} />
        <NavItem icon="git-branch-outline" label="Git" onPress={() => onNavigate('Git')} />
        <NavItem
          icon="shield-checkmark-outline"
          label="Privacy"
          onPress={() => onNavigate('Privacy')}
        />
        <NavItem
          icon="document-text-outline"
          label="Terms"
          onPress={() => onNavigate('Terms')}
        />

        {/* Threads section */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Threads</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.textMuted} style={styles.loader} />
        ) : (
          <FlatList
            data={threads}
            keyExtractor={(item) => item.id}
            style={styles.list}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={<Text style={styles.emptyText}>No threads yet</Text>}
            renderItem={({ item }) => {
              const isSelected = item.id === selectedThreadId;
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.threadItem,
                    isSelected && styles.threadItemSelected,
                    pressed && styles.threadItemPressed,
                  ]}
                  onPress={() => onSelectThread(item.id)}
                >
                  <Text style={[styles.threadTitle, isSelected && styles.threadTitleSelected]} numberOfLines={1}>
                    {item.title || 'Untitled'}
                  </Text>
                  <Text style={styles.threadAge}>{relativeTime(item.updatedAt)}</Text>
                </Pressable>
              );
            }}
          />
        )}

        {/* Settings pinned at bottom */}
        <NavItem
          icon="settings-outline"
          label="Settings"
          onPress={() => onNavigate('Settings')}
          style={styles.settingsItem}
        />
      </SafeAreaView>
    </View>
  );
}

function NavItem({
  icon,
  label,
  onPress,
  style,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  style?: object;
}) {
  return (
    <View style={style}>
      <Pressable
        style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed]}
        onPress={onPress}
      >
        <Ionicons name={icon} size={18} color={colors.textPrimary} />
        <Text style={styles.navLabel}>{label}</Text>
      </Pressable>
    </View>
  );
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertThread(threads: ThreadSummary[], summary: ThreadSummary): ThreadSummary[] {
  const idx = threads.findIndex((t) => t.id === summary.id);
  const next =
    idx === -1 ? [...threads, summary] : threads.map((t, i) => (i === idx ? summary : t));
  return sortThreads(next);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgSidebar,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  newThreadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  newThreadBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  newThreadText: {
    ...typography.headline,
    color: colors.white,
    fontSize: 14,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.md,
    borderRadius: 10,
    marginBottom: spacing.xs,
  },
  navItemPressed: {
    backgroundColor: colors.bgItem,
  },
  navLabel: {
    ...typography.body,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  list: {
    flex: 1,
  },
  loader: {
    marginTop: spacing.xl,
  },
  emptyText: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  threadItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.md,
    borderRadius: 10,
    marginBottom: spacing.xs,
  },
  threadItemSelected: {
    backgroundColor: 'rgba(200, 169, 70, 0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200, 169, 70, 0.2)',
  },
  threadItemPressed: {
    backgroundColor: colors.bgItem,
  },
  threadTitle: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
    marginRight: spacing.sm,
  },
  threadTitleSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  threadAge: {
    ...typography.caption,
    flexShrink: 0,
  },
  settingsItem: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
});
