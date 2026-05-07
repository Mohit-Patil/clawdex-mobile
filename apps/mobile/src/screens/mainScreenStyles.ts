import { StyleSheet } from 'react-native';

import type { AppTheme } from '../theme';

// ── Styles ─────────────────────────────────────────────────────────

export const createWorkflowMarkdownStyles = (theme: AppTheme) => StyleSheet.create({
  body: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  paragraph: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  heading1: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 18,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  heading2: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 16,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  heading3: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  heading4: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  heading5: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  heading6: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs / 2,
  },
  bullet_list: {
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  ordered_list: {
    marginTop: 0,
    marginBottom: theme.spacing.xs,
  },
  list_item: {
    marginTop: 0,
    marginBottom: theme.spacing.xs / 2,
  },
  strong: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  em: {
    color: theme.colors.textSecondary,
    fontStyle: 'italic',
  },
  code_inline: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.inlineCodeBg,
    color: theme.colors.inlineCodeText,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.inlineCodeBorder,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  code_block: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  fence: {
    ...theme.typography.mono,
    backgroundColor: theme.colors.bgInput,
    color: theme.colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.borderHighlight,
    paddingLeft: theme.spacing.sm,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  link: {
    color: theme.colors.accent,
    textDecorationLine: 'underline',
  },
});

export const createStyles = (theme: AppTheme) => {
  const agentPanelShadow = theme.isDark
    ? '0 12px 30px rgba(0, 0, 0, 0.22)'
    : '0 12px 24px rgba(15, 23, 42, 0.12)';

  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgMain,
  },

  bodyContainer: {
    flex: 1,
    position: 'relative',
  },
  keyboardAvoiding: {
    flex: 1,
  },
  composerContainer: {
    backgroundColor: theme.colors.bgMain,
  },
  composerContainerOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 4,
  },
  composerContainerResting: {
    marginBottom: 0,
  },
  queuedMessageDock: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs / 2,
  },
  activityDock: {
    backgroundColor: theme.colors.bgMain,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs / 2,
    zIndex: 3,
  },
  sessionMetaRow: {
    backgroundColor: theme.colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
    paddingVertical: theme.spacing.xs + 2,
  },
  sessionMetaRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
    paddingHorizontal: theme.spacing.lg,
  },
  topCardsRow: {
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
    zIndex: 2,
  },
  agentPanelWrap: {
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  agentPanelCard: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.sm,
    boxShadow: agentPanelShadow,
  },
  agentPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  agentPanelHeaderPressable: {
    borderRadius: theme.radius.md,
  },
  agentPanelHeaderPressed: {
    opacity: 0.84,
  },
  agentPanelHeaderCopy: {
    flex: 1,
    gap: 2,
  },
  agentPanelEyebrow: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  agentPanelSummary: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  agentPanelList: {
    gap: theme.spacing.sm,
  },
  agentPanelScroll: {
    flexGrow: 0,
  },
  agentPanelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm + 2,
  },
  agentPanelRowSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  agentPanelRowPressed: {
    opacity: 0.84,
  },
  agentPanelAccent: {
    width: 4,
    alignSelf: 'stretch',
    borderRadius: 999,
    flexShrink: 0,
  },
  agentPanelCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  agentPanelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  agentPanelTitle: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    flex: 1,
  },
  agentPanelSelectedLabel: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  agentPanelDescription: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  agentPanelStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    maxWidth: '42%',
    flexShrink: 0,
  },
  agentPanelStatusText: {
    ...theme.typography.caption,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },
  contextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    minHeight: 28,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  contextChipIndicator: {
    width: 6,
    height: 6,
    borderRadius: 999,
    flexShrink: 0,
  },
  contextChipText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
    fontSize: 11,
    lineHeight: 14,
  },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    minHeight: 28,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    minHeight: 28,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  fastChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    minHeight: 28,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    flexShrink: 0,
  },
  fastChipEnabled: {
    borderColor: theme.colors.successBorder,
    backgroundColor: theme.colors.successBg,
  },
  modelChipPressed: {
    opacity: 0.86,
  },
  sessionMetaChipDisabled: {
    opacity: 0.5,
  },
  modelChipText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
  },
  fastChipTextEnabled: {
    color: theme.colors.textPrimary,
  },
  planCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 12,
    backgroundColor: theme.colors.bgItem,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  planOverlayCard: {
    marginBottom: 0,
    boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.16)',
  },
  queuedMessageCard: {
    marginBottom: 0,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: 10,
  },
  queuedMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs / 2,
  },
  queuedMessageHeaderText: {
    flex: 1,
    gap: 2,
  },
  queuedMessageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  queuedMessageSummary: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  queuedMessageBody: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    lineHeight: 18,
  },
  queuedMessageHint: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  workflowSection: {
    marginTop: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  workflowSectionEyebrow: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  workflowScrollViewport: {
    marginTop: theme.spacing.xs,
  },
  workflowScrollContent: {
    paddingBottom: theme.spacing.xs,
  },
  workflowSummaryText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    lineHeight: 18,
  },
  workflowMetaText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  queuedMessageActionButton: {
    flexShrink: 0,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.inlineCodeBg,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
  },
  queuedMessageActionButtonDestructive: {
    borderColor: theme.colors.error,
    backgroundColor: theme.colors.errorBg,
  },
  queuedMessageActionButtonDisabled: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgMain,
  },
  queuedMessageActionButtonPressed: {
    opacity: 0.88,
  },
  queuedMessageActionLabel: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  queuedMessageActionLabelDestructive: {
    color: theme.colors.error,
  },
  queuedMessageActionLabelDisabled: {
    color: theme.colors.textMuted,
  },
  planCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  planCardHeaderPressable: {
    marginBottom: 0,
  },
  planCardHeaderText: {
    flex: 1,
    gap: 2,
  },
  planCardTitle: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  planCardSummary: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  planExplanationText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontStyle: 'italic',
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  planStepsList: {
    gap: theme.spacing.xs,
  },
  planStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  planStepMarkdownWrap: {
    flex: 1,
    minWidth: 0,
  },
  planStepStatus: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  planStepStatusCompleted: {
    color: theme.colors.textMuted,
  },
  planStepStatusInProgress: {
    color: theme.colors.accent,
    fontWeight: '700',
  },
  planStepStatusPending: {
    color: theme.colors.textMuted,
  },
  planStepText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
  },
  planStepTextCompleted: {
    color: theme.colors.textMuted,
    textDecorationLine: 'line-through',
  },
  planStepTextInProgress: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  planStepTextPending: {
    color: theme.colors.textPrimary,
  },
  planDeltaText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  renameModalBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlayBackdrop,
    paddingHorizontal: theme.spacing.lg,
    justifyContent: 'center',
  },
  renameModalKeyboardAvoider: {
    flex: 1,
  },
  renameModalKeyboardContent: {
    flex: 1,
    justifyContent: 'center',
  },
  renameModalKeyboardContentBottom: {
    justifyContent: 'flex-end',
  },
  workspaceModalLoading: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  inlineMentionStatus: {
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.xs,
  },
  slashSuggestions: {
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.xs,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    overflow: 'hidden',
  },
  slashSuggestionsContent: {
    paddingVertical: 0,
  },
  slashSuggestionItem: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  slashSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  slashSuggestionItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  slashSuggestionTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  slashSuggestionSummary: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  renameModalCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    maxHeight: '82%',
  },
  renameModalTitle: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
  },
  attachmentModalHint: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  attachmentSuggestionsList: {
    maxHeight: 170,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 10,
    backgroundColor: theme.colors.bgMain,
  },
  attachmentSuggestionsListContent: {
    paddingVertical: 0,
  },
  attachmentSuggestionItem: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  attachmentSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  attachmentSuggestionItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  attachmentSuggestionText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
  },
  renameModalInput: {
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: 15,
  },
  gitCheckoutHint: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },
  gitCheckoutPathButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  gitCheckoutPathButtonPressed: {
    opacity: 0.85,
  },
  gitCheckoutPathCopy: {
    flex: 1,
    gap: 2,
  },
  gitCheckoutPathLabel: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  gitCheckoutPathValue: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  gitCheckoutSummary: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  gitCheckoutErrorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  attachmentListColumn: {
    gap: theme.spacing.xs,
    maxHeight: 180,
  },
  attachmentListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 8,
    backgroundColor: theme.colors.bgMain,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  attachmentListPath: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
  },
  attachmentRemoveButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
  },
  attachmentRemoveButtonPressed: {
    opacity: 0.8,
  },
  renameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  renameModalButton: {
    borderRadius: 10,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
  },
  renameModalButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgMain,
  },
  renameModalButtonSecondaryText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
  },
  renameModalButtonPrimary: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  renameModalButtonPrimaryPressed: {
    backgroundColor: theme.colors.accentPressed,
    borderColor: theme.colors.accentPressed,
  },
  renameModalButtonDisabled: {
    opacity: 0.45,
  },
  renameModalButtonPressed: {
    opacity: 0.8,
  },
  renameModalButtonPrimaryText: {
    ...theme.typography.body,
    color: theme.colors.accentText,
    fontWeight: '600',
  },
  userInputModalBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlayBackdrop,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  userInputModalCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    maxHeight: '80%',
  },
  planPromptModalCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    maxHeight: '80%',
  },
  userInputModalTitle: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
  },
  planPromptOptionsColumn: {
    gap: theme.spacing.sm,
  },
  planPromptOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgMain,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  planPromptOptionButtonPressed: {
    opacity: 0.88,
  },
  planPromptOptionButtonDisabled: {
    opacity: 0.45,
  },
  planPromptOptionTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  planPromptOptionTitleDisabled: {
    color: theme.colors.textMuted,
  },
  planPromptOptionDescription: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  planPromptOptionDescriptionDisabled: {
    color: theme.colors.textMuted,
  },
  userInputQuestionsList: {
    maxHeight: 380,
  },
  userInputQuestionsListContent: {
    gap: theme.spacing.md,
  },
  userInputQuestionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: 10,
    backgroundColor: theme.colors.bgMain,
    padding: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  userInputQuestionHeader: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  userInputQuestionText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  userInputOptionsColumn: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
  },
  userInputOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: 2,
  },
  userInputOptionButtonSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  userInputOptionButtonPressed: {
    opacity: 0.85,
  },
  userInputOptionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  userInputOptionIndex: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '700',
    minWidth: 18,
  },
  userInputOptionLabel: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    flex: 1,
    fontWeight: '600',
  },
  userInputOptionDescription: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  userInputAnswerInput: {
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    minHeight: 42,
    textAlignVertical: 'top',
  },
  userInputAnswerInputSecret: {
    textAlignVertical: 'center',
  },
  userInputErrorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  userInputSubmitButton: {
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
    borderRadius: 10,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  },
  userInputSubmitButtonPressed: {
    opacity: 0.88,
  },
  userInputSubmitButtonDisabled: {
    opacity: 0.45,
  },
  userInputSubmitButtonText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },

  // Compose
  composeScroll: {
    flex: 1,
  },
  composeContainer: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    paddingBottom: theme.spacing.xxl * 2,
  },
  composeContainerKeyboardOpen: {
    justifyContent: 'flex-start',
    paddingTop: theme.spacing.xl,
    paddingBottom: theme.spacing.xl,
  },
  composeIcon: {
    marginBottom: theme.spacing.lg,
  },
  composeTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xl,
  },
  workspaceSelectBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.xl * 2,
  },
  workspacePathSelectBtn: {
    alignItems: 'flex-start',
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
  },
  workspaceSelectBtnPressed: {
    opacity: 0.85,
  },
  workspaceSelectLabel: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    flex: 1,
  },
  workspacePathSelectLabel: {
    flexShrink: 1,
    lineHeight: 18,
  },
  suggestions: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    width: '100%',
  },
  suggestionCard: {
    flex: 1,
    backgroundColor: theme.colors.bgItem,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    padding: theme.spacing.md,
  },
  suggestionCardPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  suggestionText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    lineHeight: 18,
  },

  // Chat
  messageListShell: {
    flex: 1,
  },
  messageList: {
    flex: 1,
  },
  jumpToLatestButton: {
    position: 'absolute',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgElevated,
    borderRadius: theme.radius.full,
    width: 34,
    height: 34,
    boxShadow: theme.isDark
      ? '0 12px 24px rgba(0, 0, 0, 0.28)'
      : '0 10px 22px rgba(15, 31, 54, 0.12)',
  },
  jumpToLatestButtonPressed: {
    opacity: 0.84,
  },
  messageListContent: {
    flexGrow: 1,
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.xl,
  },
  chatMessageBlock: {
    gap: theme.spacing.sm,
  },
  inlineChoiceOptions: {
    marginLeft: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  inlineChoiceOptionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: 2,
  },
  inlineChoiceOptionButtonPressed: {
    backgroundColor: theme.colors.bgInput,
    borderColor: theme.colors.borderHighlight,
  },
  inlineChoiceOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  inlineChoiceOptionIndex: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '700',
    minWidth: 18,
  },
  inlineChoiceOptionLabel: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
    flex: 1,
  },
  inlineChoiceOptionDescription: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  inlineChoiceHint: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    marginTop: 2,
    marginLeft: theme.spacing.xs,
  },
  chatOpeningShell: {
    flex: 1,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
  },
  chatOpeningCard: {
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  chatOpeningTopRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  chatOpeningTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '700',
  },
  chatOpeningBubbleWide: {
    width: '82%',
    height: 18,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.bgInput,
  },
  chatOpeningBubbleShort: {
    width: '54%',
    height: 18,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.bgInput,
  },

  // Streaming thinking text
  streamingText: {
    ...theme.typography.body,
    fontStyle: 'italic',
    color: theme.colors.textMuted,
    lineHeight: 20,
  },

  // Error
  bridgeRecoveryBanner: {
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.warningBg,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  bridgeRecoveryBannerTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  bridgeRecoveryBannerIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgItem,
  },
  bridgeRecoveryBannerCopy: {
    flex: 1,
    gap: 2,
  },
  bridgeRecoveryBannerTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  bridgeRecoveryBannerBody: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 17,
  },
  bridgeRecoveryBannerStatus: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    lineHeight: 17,
  },
  bridgeRecoveryBannerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  bridgeRecoveryBannerButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  bridgeRecoveryBannerButtonPressed: {
    backgroundColor: theme.colors.accentPressed,
    borderColor: theme.colors.accentPressed,
  },
  bridgeRecoveryBannerButtonDisabled: {
    opacity: 0.72,
  },
  bridgeRecoveryBannerButtonText: {
    ...theme.typography.caption,
    color: theme.colors.accentText,
    fontWeight: '700',
  },
  bridgeRecoveryBannerSecondaryButton: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  bridgeRecoveryBannerSecondaryButtonPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  bridgeRecoveryBannerSecondaryButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '700',
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
});
};
