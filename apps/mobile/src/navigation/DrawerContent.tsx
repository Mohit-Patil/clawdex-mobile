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
import type { ChatSummary, RpcNotification } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, spacing, typography } from '../theme';

type Screen = 'Main' | 'Terminal' | 'Settings' | 'Privacy' | 'Terms';

interface DrawerContentProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  selectedChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNavigate: (screen: Screen) => void;
}

export function DrawerContent({
  api,
  ws,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onNavigate,
}: DrawerContentProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadChats = useCallback(async () => {
    try {
      const data = await api.listChats();
      setChats(sortChats(data));
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      if (
        event.method === 'thread/started' ||
        event.method === 'thread/name/updated' ||
        event.method === 'turn/completed' ||
        event.method === 'thread/status/changed'
      ) {
        void loadChats();
      }
    });
  }, [ws, loadChats]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadChats();
    }, 4000);

    return () => clearInterval(timer);
  }, [loadChats]);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.mainContent}>
          {/* New Chat button */}
          <View style={styles.header}>
            <Pressable
              style={({ pressed }) => [
                styles.navItem,
                styles.newChatBtn,
                pressed && styles.navItemPressed,
              ]}
              onPress={onNewChat}
            >
              <Ionicons name="add" size={16} color={colors.textPrimary} />
              <Text style={styles.newChatText}>New chat</Text>
            </Pressable>
          </View>

          {/* Nav items */}
          <NavItem icon="terminal-outline" label="Terminal" onPress={() => onNavigate('Terminal')} />
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

          {/* Chats section */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Chats</Text>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.textMuted} style={styles.loader} />
          ) : (
            <FlatList
              data={chats}
              keyExtractor={(item) => item.id}
              style={styles.list}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={<Text style={styles.emptyText}>No chats yet</Text>}
              renderItem={({ item }) => {
                const isSelected = item.id === selectedChatId;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.chatItem,
                      isSelected && styles.chatItemSelected,
                      pressed && styles.chatItemPressed,
                    ]}
                    onPress={() => onSelectChat(item.id)}
                  >
                    <Text style={[styles.chatTitle, isSelected && styles.chatTitleSelected]} numberOfLines={1}>
                      {item.title || 'Untitled'}
                    </Text>
                    <Text style={styles.chatAge}>{relativeTime(item.updatedAt)}</Text>
                  </Pressable>
                );
              }}
            />
          )}
        </View>

        <View style={styles.footer}>
          <NavItem
            icon="settings-outline"
            label="Settings"
            onPress={() => onNavigate('Settings')}
            style={styles.settingsItem}
          />
        </View>
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

function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  mainContent: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  newChatBtn: {
    marginHorizontal: 0,
    marginBottom: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
  },
  newChatText: {
    ...typography.body,
    fontWeight: '500',
    color: colors.textPrimary,
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
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.md,
    borderRadius: 10,
    marginBottom: spacing.xs,
  },
  chatItemSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
  },
  chatItemPressed: {
    backgroundColor: colors.bgItem,
  },
  chatTitle: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
    marginRight: spacing.sm,
  },
  chatTitleSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  chatAge: {
    ...typography.caption,
    flexShrink: 0,
  },
  settingsItem: {
    marginBottom: 0,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
});
