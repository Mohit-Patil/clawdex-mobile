import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  filterPrompts,
  MAX_PROMPT_BODY_LENGTH,
  MAX_PROMPT_TITLE_LENGTH,
  type SavedPrompt,
  type SavedPromptDraft,
} from '../promptLibrary';
import { useAppTheme, type AppTheme } from '../theme';

interface PromptLibrarySheetProps {
  visible: boolean;
  prompts: SavedPrompt[];
  onClose: () => void;
  onInsert: (prompt: SavedPrompt) => void;
  onSavePrompt: (draft: SavedPromptDraft) => void;
  onDeletePrompt: (id: string) => void;
}

type EditorState = { id: string | null; title: string; body: string } | null;

export function PromptLibrarySheet({
  visible,
  prompts,
  onClose,
  onInsert,
  onSavePrompt,
  onDeletePrompt,
}: PromptLibrarySheetProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<EditorState>(null);

  // Reset transient UI whenever the sheet is dismissed so it reopens clean.
  useEffect(() => {
    if (!visible) {
      setQuery('');
      setEditor(null);
    }
  }, [visible]);

  const visiblePrompts = useMemo(() => filterPrompts(prompts, query), [prompts, query]);

  const cardMaxHeight = Math.min(
    Math.max(420, Math.round(windowHeight * 0.78)),
    windowHeight - Math.max(insets.top + theme.spacing.lg, 64)
  );

  const editing = editor !== null;
  const editorTitle = editor?.title ?? '';
  const editorBody = editor?.body ?? '';
  const canSave = editorBody.trim().length > 0;

  const beginCreate = () => setEditor({ id: null, title: '', body: query.trim() });
  const beginEdit = (prompt: SavedPrompt) =>
    setEditor({ id: prompt.id, title: prompt.title, body: prompt.body });

  const commitEditor = () => {
    if (!editor || editor.body.trim().length === 0) {
      return;
    }
    onSavePrompt({ id: editor.id, title: editor.title, body: editor.body });
    setEditor(null);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      presentationStyle="overFullScreen"
      onRequestClose={() => (editing ? setEditor(null) : onClose())}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => (editing ? setEditor(null) : onClose())}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.avoider}
          pointerEvents="box-none"
        >
          <View
            style={[
              styles.sheetCard,
              { maxHeight: cardMaxHeight, paddingBottom: Math.max(insets.bottom, theme.spacing.lg) },
            ]}
          >
            <View style={styles.handle} />

            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>Prompt library</Text>
                <Text style={styles.title}>
                  {editing ? (editor?.id ? 'Edit prompt' : 'New prompt') : 'Saved prompts'}
                </Text>
              </View>
              <Pressable
                onPress={() => (editing ? setEditor(null) : onClose())}
                hitSlop={8}
                style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
              >
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </Pressable>
            </View>

            {editing ? (
              <ScrollView
                style={styles.editorScroll}
                contentContainerStyle={styles.editorContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.fieldLabel}>Title</Text>
                <TextInput
                  value={editorTitle}
                  onChangeText={(text) =>
                    setEditor((prev) => (prev ? { ...prev, title: text } : prev))
                  }
                  placeholder="Optional — defaults to the first line"
                  placeholderTextColor={colors.textMuted}
                  keyboardAppearance={theme.keyboardAppearance}
                  maxLength={MAX_PROMPT_TITLE_LENGTH}
                  style={styles.titleInput}
                  returnKeyType="next"
                />

                <Text style={styles.fieldLabel}>Prompt</Text>
                <TextInput
                  value={editorBody}
                  onChangeText={(text) =>
                    setEditor((prev) => (prev ? { ...prev, body: text } : prev))
                  }
                  placeholder="What should the agent do?"
                  placeholderTextColor={colors.textMuted}
                  keyboardAppearance={theme.keyboardAppearance}
                  maxLength={MAX_PROMPT_BODY_LENGTH}
                  style={styles.bodyInput}
                  multiline
                  textAlignVertical="top"
                />

                <View style={styles.editorActions}>
                  <Pressable
                    onPress={() => setEditor(null)}
                    style={({ pressed }) => [
                      styles.secondaryBtn,
                      pressed && styles.secondaryBtnPressed,
                    ]}
                  >
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={commitEditor}
                    disabled={!canSave}
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      !canSave && styles.primaryBtnDisabled,
                      pressed && canSave && styles.primaryBtnPressed,
                    ]}
                  >
                    <Ionicons name="checkmark" size={16} color={colors.accentText} />
                    <Text style={styles.primaryBtnText}>Save</Text>
                  </Pressable>
                </View>
              </ScrollView>
            ) : (
              <>
                <View style={styles.searchRow}>
                  <Ionicons name="search" size={15} color={colors.textMuted} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search prompts"
                    placeholderTextColor={colors.textMuted}
                    keyboardAppearance={theme.keyboardAppearance}
                    style={styles.searchInput}
                    autoCorrect={false}
                  />
                  {query.length > 0 ? (
                    <Pressable onPress={() => setQuery('')} hitSlop={8}>
                      <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                    </Pressable>
                  ) : null}
                </View>

                <ScrollView
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {visiblePrompts.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Ionicons name="bookmark-outline" size={22} color={colors.textMuted} />
                      <Text style={styles.emptyText}>
                        {prompts.length === 0
                          ? 'Save prompts you reuse often, then insert them with one tap.'
                          : 'No prompts match your search.'}
                      </Text>
                    </View>
                  ) : (
                    visiblePrompts.map((prompt) => (
                      <Pressable
                        key={prompt.id}
                        onPress={() => onInsert(prompt)}
                        style={({ pressed }) => [
                          styles.promptRow,
                          pressed && styles.promptRowPressed,
                        ]}
                      >
                        <View style={styles.promptCopy}>
                          <Text style={styles.promptTitle} numberOfLines={1}>
                            {prompt.title}
                          </Text>
                          <Text style={styles.promptBody} numberOfLines={2}>
                            {prompt.body}
                          </Text>
                        </View>
                        <View style={styles.promptActions}>
                          <Pressable
                            onPress={() => beginEdit(prompt)}
                            hitSlop={8}
                            style={({ pressed }) => [
                              styles.rowIconBtn,
                              pressed && styles.rowIconBtnPressed,
                            ]}
                          >
                            <Ionicons name="create-outline" size={16} color={colors.textMuted} />
                          </Pressable>
                          <Pressable
                            onPress={() => onDeletePrompt(prompt.id)}
                            hitSlop={8}
                            style={({ pressed }) => [
                              styles.rowIconBtn,
                              pressed && styles.rowIconBtnPressed,
                            ]}
                          >
                            <Ionicons name="trash-outline" size={16} color={colors.error} />
                          </Pressable>
                        </View>
                      </Pressable>
                    ))
                  )}
                </ScrollView>

                <Pressable
                  onPress={beginCreate}
                  style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
                >
                  <Ionicons name="add" size={18} color={colors.accentText} />
                  <Text style={styles.addBtnText}>New prompt</Text>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: theme.colors.overlayBackdrop,
      justifyContent: 'flex-end',
    },
    avoider: {
      justifyContent: 'flex-end',
    },
    sheetCard: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      gap: theme.spacing.md,
      boxShadow: theme.isDark
        ? '0 -10px 34px rgba(0, 0, 0, 0.42)'
        : '0 -10px 34px rgba(15, 23, 42, 0.12)',
    },
    handle: {
      alignSelf: 'center',
      width: 38,
      height: 4,
      borderRadius: 999,
      backgroundColor: theme.colors.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    headerCopy: {
      flexShrink: 1,
      gap: 4,
    },
    eyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 10,
      lineHeight: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    title: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '700',
    },
    headerBtn: {
      width: 30,
      height: 30,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgItem,
    },
    headerBtnPressed: {
      backgroundColor: theme.colors.bgInput,
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      height: 40,
      borderRadius: 12,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    searchInput: {
      flex: 1,
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 15,
      padding: 0,
    },
    list: {
      flexGrow: 0,
    },
    listContent: {
      gap: theme.spacing.sm,
      paddingBottom: theme.spacing.xs,
    },
    emptyState: {
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xl,
      paddingHorizontal: theme.spacing.lg,
    },
    emptyText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
      textAlign: 'center',
    },
    promptRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      padding: theme.spacing.md,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    promptRowPressed: {
      backgroundColor: theme.colors.bgInput,
      borderColor: theme.colors.borderHighlight,
    },
    promptCopy: {
      flex: 1,
      gap: 3,
    },
    promptTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    promptBody: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 12,
      lineHeight: 16,
    },
    promptActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    rowIconBtn: {
      width: 30,
      height: 30,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowIconBtnPressed: {
      backgroundColor: theme.colors.bgInput,
    },
    addBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      height: 46,
      borderRadius: 14,
      borderCurve: 'continuous',
      backgroundColor: theme.colors.accent,
    },
    addBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    addBtnText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontSize: 15,
      fontWeight: '700',
    },
    editorScroll: {
      flexGrow: 0,
    },
    editorContent: {
      gap: theme.spacing.sm,
      paddingBottom: theme.spacing.sm,
    },
    fieldLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      marginTop: theme.spacing.xs,
    },
    titleInput: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 15,
      paddingHorizontal: theme.spacing.md,
      height: 44,
      borderRadius: 12,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    bodyInput: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 15,
      lineHeight: 21,
      minHeight: 132,
      maxHeight: 240,
      padding: theme.spacing.md,
      borderRadius: 12,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
    },
    editorActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    secondaryBtn: {
      paddingHorizontal: theme.spacing.lg,
      height: 42,
      borderRadius: 12,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    secondaryBtnPressed: {
      backgroundColor: theme.colors.bgInput,
    },
    secondaryBtnText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontSize: 15,
      fontWeight: '600',
    },
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
      height: 42,
      borderRadius: 12,
      borderCurve: 'continuous',
      backgroundColor: theme.colors.accent,
    },
    primaryBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    primaryBtnDisabled: {
      opacity: 0.5,
    },
    primaryBtnText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontSize: 15,
      fontWeight: '700',
    },
  });
