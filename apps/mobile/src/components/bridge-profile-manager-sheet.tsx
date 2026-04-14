import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BridgeProfile } from '../bridgeProfiles';
import { useAppTheme, type AppTheme } from '../theme';

interface BridgeProfileManagerSheetProps {
  visible: boolean;
  profiles: BridgeProfile[];
  activeProfileId?: string | null;
  onClose: () => void;
  onActivate?: (profileId: string) => void | Promise<void>;
  onRename?: (profileId: string, nextName: string) => void | Promise<void>;
  onDelete?: (profileId: string) => void | Promise<void>;
}

export function BridgeProfileManagerSheet({
  visible,
  profiles,
  activeProfileId = null,
  onClose,
  onActivate,
  onRename,
  onDelete,
}: BridgeProfileManagerSheetProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string | null>(null);
  const [actionProfileId, setActionProfileId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setEditingProfileId(null);
      setRenameDraft('');
      setPendingDeleteProfileId(null);
      setActionProfileId(null);
      setActionError(null);
    }
  }, [visible]);

  const cardMaxHeight = Math.min(
    Math.max(420, Math.round(windowHeight * 0.76)),
    windowHeight - Math.max(insets.top + theme.spacing.xl, 72) - Math.max(insets.bottom + theme.spacing.xl, 72)
  );

  const beginRename = (profile: BridgeProfile) => {
    setActionError(null);
    setPendingDeleteProfileId(null);
    setEditingProfileId(profile.id);
    setRenameDraft(profile.name);
  };

  const cancelInlineState = () => {
    setEditingProfileId(null);
    setRenameDraft('');
    setPendingDeleteProfileId(null);
    setActionError(null);
  };

  const activateProfile = async (profileId: string) => {
    if (!onActivate) {
      return;
    }
    setActionProfileId(profileId);
    setActionError(null);
    try {
      await onActivate(profileId);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionProfileId(null);
    }
  };

  const saveRename = async () => {
    if (!editingProfileId || !onRename) {
      return;
    }
    setActionProfileId(editingProfileId);
    setActionError(null);
    try {
      await onRename(editingProfileId, renameDraft.trim());
      setEditingProfileId(null);
      setRenameDraft('');
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionProfileId(null);
    }
  };

  const deleteProfile = async (profileId: string) => {
    if (!onDelete) {
      return;
    }
    setActionProfileId(profileId);
    setActionError(null);
    try {
      await onDelete(profileId);
      setPendingDeleteProfileId(null);
      setEditingProfileId((current) => (current === profileId ? null : current));
      setRenameDraft('');
      if (profiles.length <= 1) {
        onClose();
      }
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionProfileId(null);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardAvoider}
        >
          <SafeAreaView edges={['bottom']} style={styles.safeArea}>
            <View style={[styles.sheetCard, { maxHeight: cardMaxHeight }]}>
              <View style={styles.handle} />
              <View style={styles.header}>
                <Text style={styles.eyebrow}>Bridge Profiles</Text>
                <Text style={styles.title}>Manage saved bridges</Text>
                <Text style={styles.subtitle}>
                  Switch the active server, rename profiles so they are easier to recognize, or
                  remove old bridges you no longer use.
                </Text>
              </View>

              {actionError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {actionError}
                  </Text>
                </View>
              ) : null}

              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {profiles.length > 0 ? (
                  profiles.map((profile) => {
                    const isActive = profile.id === activeProfileId;
                    const isEditing = profile.id === editingProfileId;
                    const isPendingDelete = profile.id === pendingDeleteProfileId;
                    const isBusy = profile.id === actionProfileId;

                    return (
                      <View
                        key={profile.id}
                        style={[styles.profileRow, isActive && styles.profileRowActive]}
                      >
                        <View style={styles.profileHeader}>
                          <View style={styles.profileCopy}>
                            <View style={styles.profileTitleRow}>
                              <Text style={styles.profileTitle} numberOfLines={1}>
                                {profile.name}
                              </Text>
                              {isActive ? (
                                <View style={styles.activeBadge}>
                                  <Text style={styles.activeBadgeText}>Active</Text>
                                </View>
                              ) : null}
                            </View>
                            <View style={styles.profileMetaRow}>
                              <View style={styles.metaBadge}>
                                <Text style={styles.metaBadgeText}>
                                  {profile.authMode === 'githubOAuth'
                                    ? 'GitHub Codespace'
                                    : 'Bridge token'}
                                </Text>
                              </View>
                              {profile.githubUserLogin ? (
                                <Text style={styles.metaText}>@{profile.githubUserLogin}</Text>
                              ) : null}
                            </View>
                            <Text selectable style={styles.profileUrl} numberOfLines={2}>
                              {profile.bridgeUrl}
                            </Text>
                          </View>

                          {isBusy ? (
                            <View style={styles.activateButton}>
                              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                            </View>
                          ) : isActive ? (
                            <View style={styles.activeState}>
                              <Ionicons
                                name="checkmark-circle-outline"
                                size={18}
                                color={theme.colors.statusComplete}
                              />
                            </View>
                          ) : (
                            <Pressable
                              onPress={() => {
                                void activateProfile(profile.id);
                              }}
                              style={({ pressed }) => [
                                styles.activateButton,
                                pressed && styles.activateButtonPressed,
                              ]}
                            >
                              <Text style={styles.activateButtonText}>Use</Text>
                            </Pressable>
                          )}
                        </View>

                        {!isEditing && !isPendingDelete ? (
                          <View style={styles.profileToolsRow}>
                            <Pressable
                              onPress={() => beginRename(profile)}
                              style={({ pressed }) => [
                                styles.toolButton,
                                pressed && styles.toolButtonPressed,
                              ]}
                            >
                              <Ionicons
                                name="create-outline"
                                size={14}
                                color={theme.colors.textPrimary}
                              />
                              <Text style={styles.toolButtonText}>Rename</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                setActionError(null);
                                setEditingProfileId(null);
                                setPendingDeleteProfileId(profile.id);
                              }}
                              style={({ pressed }) => [
                                styles.toolButton,
                                styles.toolButtonDanger,
                                pressed && styles.toolButtonDangerPressed,
                              ]}
                            >
                              <Ionicons name="trash-outline" size={14} color={theme.colors.error} />
                              <Text style={styles.toolButtonDangerText}>Delete</Text>
                            </Pressable>
                          </View>
                        ) : null}

                        {isEditing ? (
                          <View style={styles.inlineEditor}>
                            <Text style={styles.inlineLabel}>Profile name</Text>
                            <TextInput
                              value={renameDraft}
                              onChangeText={setRenameDraft}
                              placeholder="Name this bridge"
                              placeholderTextColor={theme.colors.textMuted}
                              autoFocus
                              returnKeyType="done"
                              onSubmitEditing={() => {
                                void saveRename();
                              }}
                              style={styles.inlineInput}
                            />
                            <View style={styles.inlineActions}>
                              <Pressable
                                onPress={cancelInlineState}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.inlineButtonSecondary,
                                  pressed && styles.inlineButtonPressed,
                                ]}
                              >
                                <Text style={styles.inlineButtonSecondaryText}>Cancel</Text>
                              </Pressable>
                              <Pressable
                                onPress={() => {
                                  void saveRename();
                                }}
                                disabled={!renameDraft.trim() || isBusy}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.inlineButtonPrimary,
                                  pressed && !isBusy && styles.inlineButtonPrimaryPressed,
                                  (!renameDraft.trim() || isBusy) && styles.inlineButtonDisabled,
                                ]}
                              >
                                <Text style={styles.inlineButtonPrimaryText}>Save name</Text>
                              </Pressable>
                            </View>
                          </View>
                        ) : null}

                        {isPendingDelete ? (
                          <View style={styles.deleteConfirm}>
                            <Text style={styles.deleteConfirmTitle}>Delete this profile?</Text>
                            <Text style={styles.deleteConfirmBody}>
                              This removes the saved bridge URL and token from the device. If it is
                              active, Clawdex will switch to another saved profile or return to
                              onboarding if none remain.
                            </Text>
                            <View style={styles.inlineActions}>
                              <Pressable
                                onPress={cancelInlineState}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.inlineButtonSecondary,
                                  pressed && styles.inlineButtonPressed,
                                ]}
                              >
                                <Text style={styles.inlineButtonSecondaryText}>Keep profile</Text>
                              </Pressable>
                              <Pressable
                                onPress={() => {
                                  void deleteProfile(profile.id);
                                }}
                                disabled={isBusy}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.deleteButton,
                                  pressed && !isBusy && styles.deleteButtonPressed,
                                  isBusy && styles.inlineButtonDisabled,
                                ]}
                              >
                                <Text style={styles.deleteButtonText}>Delete</Text>
                              </Pressable>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyStateTitle}>No saved profiles</Text>
                    <Text style={styles.emptyStateBody}>
                      Add a bridge or connect a GitHub Codespace to create your first saved profile.
                    </Text>
                  </View>
                )}
              </ScrollView>

              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
              >
                <Text style={styles.closeButtonText}>Done</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const createStyles = (theme: AppTheme) => {
  const cardBorder = theme.isDark ? theme.colors.borderHighlight : 'rgba(67, 96, 126, 0.24)';
  const raisedFill = theme.isDark ? 'rgba(198, 205, 217, 0.08)' : 'rgba(255, 255, 255, 0.86)';
  const subtleFill = theme.isDark ? theme.colors.bgItem : '#E8EEF4';

  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: theme.colors.overlayBackdrop,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    keyboardAvoider: {
      flex: 1,
      justifyContent: 'center',
    },
    safeArea: {
      justifyContent: 'center',
    },
    sheetCard: {
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cardBorder,
      backgroundColor: theme.isDark ? theme.colors.bgElevated : theme.colors.bgElevated,
      overflow: 'hidden',
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.md,
      boxShadow: theme.isDark
        ? '0px 24px 64px rgba(0, 0, 0, 0.34)'
        : '0px 18px 40px rgba(15, 31, 54, 0.18)',
    },
    handle: {
      alignSelf: 'center',
      width: 44,
      height: 5,
      borderRadius: 999,
      backgroundColor: theme.colors.borderHighlight,
    },
    header: {
      gap: theme.spacing.xs,
    },
    eyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    title: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
    },
    subtitle: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      lineHeight: 21,
    },
    errorBanner: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.isDark ? 'rgba(239, 68, 68, 0.28)' : 'rgba(217, 45, 32, 0.24)',
      backgroundColor: theme.colors.errorBg,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
    },
    errorBannerText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      flex: 1,
      lineHeight: 18,
    },
    list: {
      flexGrow: 0,
    },
    listContent: {
      gap: theme.spacing.md,
    },
    profileRow: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: raisedFill,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    profileRowActive: {
      borderColor: theme.isDark ? 'rgba(198, 205, 217, 0.34)' : 'rgba(14, 159, 110, 0.30)',
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.11)' : 'rgba(14, 159, 110, 0.08)',
    },
    profileHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
    },
    profileCopy: {
      flex: 1,
      gap: theme.spacing.xs,
    },
    profileTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: theme.spacing.xs,
    },
    profileTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      flexShrink: 1,
    },
    activeBadge: {
      borderRadius: 999,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
      backgroundColor: theme.isDark ? 'rgba(198, 205, 217, 0.16)' : 'rgba(14, 159, 110, 0.14)',
    },
    activeBadgeText: {
      ...theme.typography.caption,
      color: theme.colors.statusComplete,
      fontWeight: '700',
    },
    profileMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    metaBadge: {
      borderRadius: 999,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
      backgroundColor: subtleFill,
    },
    metaBadgeText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    metaText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    profileUrl: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    activateButton: {
      minWidth: 64,
      minHeight: 36,
      borderRadius: theme.radius.md,
      backgroundColor: subtleFill,
      paddingHorizontal: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    activateButtonPressed: {
      opacity: 0.88,
    },
    activateButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    activeState: {
      minWidth: 36,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    profileToolsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    toolButton: {
      minHeight: 34,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: subtleFill,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    toolButtonPressed: {
      opacity: 0.88,
    },
    toolButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    toolButtonDanger: {
      backgroundColor: theme.colors.errorBg,
      borderColor: theme.isDark ? 'rgba(239, 68, 68, 0.24)' : 'rgba(217, 45, 32, 0.22)',
    },
    toolButtonDangerPressed: {
      opacity: 0.9,
    },
    toolButtonDangerText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      fontWeight: '700',
    },
    inlineEditor: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: cardBorder,
      paddingTop: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    inlineLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    inlineInput: {
      minHeight: 46,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: theme.colors.bgMain,
      paddingHorizontal: theme.spacing.md,
      color: theme.colors.textPrimary,
      ...theme.typography.body,
    },
    inlineActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    inlineButton: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    inlineButtonPressed: {
      opacity: 0.88,
    },
    inlineButtonSecondary: {
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: subtleFill,
    },
    inlineButtonSecondaryText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    inlineButtonPrimary: {
      backgroundColor: theme.colors.textPrimary,
    },
    inlineButtonPrimaryPressed: {
      opacity: 0.92,
    },
    inlineButtonPrimaryText: {
      ...theme.typography.caption,
      color: theme.colors.black,
      fontWeight: '700',
    },
    inlineButtonDisabled: {
      opacity: 0.45,
    },
    deleteConfirm: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: cardBorder,
      paddingTop: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    deleteConfirmTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    deleteConfirmBody: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    deleteButton: {
      backgroundColor: theme.colors.error,
    },
    deleteButtonPressed: {
      opacity: 0.9,
    },
    deleteButtonText: {
      ...theme.typography.caption,
      color: theme.colors.white,
      fontWeight: '700',
    },
    emptyState: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: raisedFill,
      padding: theme.spacing.lg,
      gap: theme.spacing.xs,
    },
    emptyStateTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
    emptyStateBody: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    closeButton: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      backgroundColor: subtleFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeButtonPressed: {
      opacity: 0.88,
    },
    closeButtonText: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '700',
    },
  });
};
