import { Ionicons } from '@expo/vector-icons';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
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

interface DrawerContentProps extends DrawerContentComponentProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
}

export function DrawerContent({
  navigation,
  api,
  ws,
  selectedThreadId,
  onSelectThread,
  onNewThread,
}: DrawerContentProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadThreads = useCallback(async () => {
    try {
      const data = await api.listThreads();
      setThreads(sortThreads(data));
    } catch {
      // silently fail - user will see empty list
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
              ? { ...t, lastMessagePreview: event.payload.content, updatedAt: event.payload.updatedAt }
              : t
          )
        );
      }
    });
  }, [ws]);

  const handleSelectThread = useCallback(
    (id: string) => {
      onSelectThread(id);
      navigation.closeDrawer();
    },
    [onSelectThread, navigation]
  );

  const handleNewThread = useCallback(() => {
    onNewThread();
    navigation.closeDrawer();
  }, [onNewThread, navigation]);

  return (
    <SafeAreaView style={styles.container}>
      {/* New Thread button */}
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.newThreadBtn, pressed && styles.newThreadBtnPressed]}
          onPress={handleNewThread}
        >
          <Ionicons name="add" size={16} color={colors.white} />
          <Text style={styles.newThreadText}>New thread</Text>
        </Pressable>
      </View>

      {/* Nav items */}
      <NavItem
        icon="terminal-outline"
        label="Terminal"
        onPress={() => { navigation.navigate('Terminal'); }}
      />
      <NavItem
        icon="git-branch-outline"
        label="Git"
        onPress={() => { navigation.navigate('Git'); }}
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
          ListEmptyComponent={
            <Text style={styles.emptyText}>No threads yet</Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.threadItem,
                item.id === selectedThreadId && styles.threadItemSelected,
                pressed && styles.threadItemPressed,
              ]}
              onPress={() => handleSelectThread(item.id)}
            >
              <Text style={styles.threadTitle} numberOfLines={1}>
                {item.title || 'Untitled'}
              </Text>
              <Text style={styles.threadAge}>
                {relativeTime(item.updatedAt)}
              </Text>
            </Pressable>
          )}
        />
      )}

      {/* Settings pinned at bottom */}
      <NavItem
        icon="settings-outline"
        label="Settings"
        onPress={() => { navigation.navigate('Settings'); }}
        style={styles.settingsItem}
      />
    </SafeAreaView>
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
    <Pressable
      style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed, style]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <Text style={styles.navLabel}>{label}</Text>
    </Pressable>
  );
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertThread(threads: ThreadSummary[], summary: ThreadSummary): ThreadSummary[] {
  const idx = threads.findIndex((t) => t.id === summary.id);
  const next = idx === -1 ? [...threads, summary] : threads.map((t, i) => (i === idx ? summary : t));
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  navItemPressed: {
    backgroundColor: colors.bgItem,
  },
  navLabel: {
    ...typography.body,
    color: colors.textMuted,
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  threadItemSelected: {
    backgroundColor: colors.bgItem,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  threadItemPressed: {
    backgroundColor: colors.bgItem,
  },
  threadTitle: {
    ...typography.body,
    flex: 1,
    marginRight: spacing.sm,
  },
  threadAge: {
    ...typography.caption,
    flexShrink: 0,
  },
  settingsItem: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.md,
  },
});
