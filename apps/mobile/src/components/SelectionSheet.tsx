import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme, type AppTheme } from '../theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type OptionTone = 'default' | 'accent' | 'danger';
type SelectionSheetPresentation = 'default' | 'expanded';

export interface SelectionSheetOption {
  key: string;
  title: string;
  description?: string;
  badge?: string;
  meta?: string;
  icon?: IoniconName;
  titleColor?: string;
  descriptionColor?: string;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
  metaColor?: string;
  iconColor?: string;
  selected?: boolean;
  disabled?: boolean;
  tone?: OptionTone;
  onPress: () => void;
}

interface SelectionSheetProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  options: SelectionSheetOption[];
  onClose: () => void;
  closeLabel?: string;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  presentation?: SelectionSheetPresentation;
}

export function SelectionSheet({
  visible,
  title,
  subtitle,
  eyebrow,
  options,
  onClose,
  closeLabel = 'Close',
  loading = false,
  loadingLabel = 'Loading…',
  emptyLabel = 'No options available.',
  presentation = 'expanded',
}: SelectionSheetProps) {
  const theme = useAppTheme();
  const { colors, spacing } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const expanded = presentation === 'expanded';
  const expandedTopInset = Math.max(insets.top + spacing.xl + 20, 112);
  const expandedBottomInset = Math.max(insets.bottom + spacing.xl + 28, 118);
  const expandedCardHeight = Math.min(
    Math.max(360, Math.round(windowHeight * 0.62)),
    windowHeight - expandedTopInset - expandedBottomInset
  );

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
        <View
          style={[
            styles.sheetOuter,
            expanded && styles.sheetOuterExpanded,
            {
              paddingBottom: expanded ? expandedBottomInset : Math.max(insets.bottom, spacing.md),
              paddingTop: expanded ? expandedTopInset : undefined,
            },
          ]}
        >
          <View
            style={[
              styles.sheetCard,
              expanded && styles.sheetCardExpanded,
              expanded ? { height: expandedCardHeight } : null,
            ]}
          >
            <View style={styles.handle} />

            <View style={styles.header}>
              {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
              <Text style={styles.title}>{title}</Text>
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={expanded ? 3 : 2}>
                  {subtitle}
                </Text>
              ) : null}
            </View>

            {loading ? (
              <View style={styles.loadingState}>
                <ActivityIndicator color={colors.textPrimary} />
                <Text style={styles.loadingLabel}>{loadingLabel}</Text>
              </View>
            ) : options.length > 0 ? (
              <ScrollView
                style={[styles.list, expanded && styles.listExpanded]}
                contentContainerStyle={[
                  styles.listContent,
                  expanded && styles.listContentExpanded,
                ]}
                showsVerticalScrollIndicator={false}
              >
                {options.map((option) => {
                  const tone = option.tone ?? 'default';
                  const iconColor =
                    option.iconColor ??
                    (tone === 'danger'
                      ? '#FF8A8A'
                      : option.selected || tone === 'accent'
                        ? colors.textPrimary
                        : colors.textMuted);
                  const titleColor = option.titleColor ?? colors.textPrimary;
                  const descriptionColor = option.descriptionColor ?? colors.textMuted;
                  const metaColor = option.metaColor ?? colors.textMuted;
                  const badgeBackgroundColor =
                    option.badgeBackgroundColor ?? styles.badge.backgroundColor;
                  const badgeTextColor =
                    option.badgeTextColor ?? styles.badgeText.color;

                  return (
                    <Pressable
                      key={option.key}
                      disabled={option.disabled}
                      onPress={option.onPress}
                      style={({ pressed }) => [
                        styles.option,
                        option.selected && styles.optionSelected,
                        option.disabled && styles.optionDisabled,
                        pressed && !option.disabled && styles.optionPressed,
                      ]}
                    >
                      <View style={styles.optionMain}>
                        {option.icon ? (
                          <View
                            style={[
                              styles.iconWrap,
                              option.selected && styles.iconWrapSelected,
                              tone === 'danger' && styles.iconWrapDanger,
                            ]}
                          >
                            <Ionicons name={option.icon} size={15} color={iconColor} />
                          </View>
                        ) : null}

                        <View style={styles.copy}>
                          <View style={styles.titleRow}>
                            <Text
                              style={[
                                styles.optionTitle,
                                option.selected && styles.optionTitleSelected,
                                { color: titleColor },
                              ]}
                              numberOfLines={2}
                            >
                              {option.title}
                            </Text>
                            {option.badge ? (
                              <View
                                style={[
                                  styles.badge,
                                  { backgroundColor: badgeBackgroundColor },
                                ]}
                              >
                                <Text style={[styles.badgeText, { color: badgeTextColor }]}>
                                  {option.badge}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                          {option.description ? (
                            <Text
                              style={[styles.optionDescription, { color: descriptionColor }]}
                              numberOfLines={2}
                            >
                              {option.description}
                            </Text>
                          ) : null}
                        </View>
                      </View>

                      <View style={styles.accessory}>
                        {option.meta ? (
                          <Text
                            style={[styles.meta, { color: metaColor }]}
                            numberOfLines={1}
                          >
                            {option.meta}
                          </Text>
                        ) : null}
                        {option.selected ? (
                          <Ionicons
                            name="checkmark-circle"
                            size={18}
                            color={colors.textPrimary}
                          />
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              <View style={styles.loadingState}>
                <Text style={styles.loadingLabel}>{emptyLabel}</Text>
              </View>
            )}

            <View style={styles.footer}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.closeButtonPressed,
                ]}
              >
                <Text style={styles.closeText}>{closeLabel}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: theme.colors.overlayBackdrop,
    },
    sheetOuter: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xl,
    },
    sheetOuterExpanded: {
      paddingHorizontal: theme.spacing.md,
    },
    sheetCard: {
      maxHeight: '82%',
      borderRadius: 24,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.md,
      boxShadow: theme.isDark
        ? '0 -10px 34px rgba(0, 0, 0, 0.42)'
        : '0 -10px 34px rgba(15, 23, 42, 0.12)',
    },
    sheetCardExpanded: {
      maxHeight: undefined,
      minHeight: undefined,
      borderRadius: 28,
    },
    handle: {
      alignSelf: 'center',
      width: 38,
      height: 4,
      borderRadius: 999,
      backgroundColor: theme.colors.border,
    },
    header: {
      gap: 4,
    },
    eyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 10,
      lineHeight: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    title: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '700',
    },
    subtitle: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 12,
      lineHeight: 16,
    },
    list: {
      maxHeight: 420,
    },
    listExpanded: {
      flex: 1,
      maxHeight: undefined,
    },
    listContent: {
      gap: theme.spacing.sm,
    },
    listContentExpanded: {
      paddingBottom: theme.spacing.xs,
    },
    loadingState: {
      minHeight: 120,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
    },
    loadingLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    option: {
      minHeight: 64,
      borderRadius: 18,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm + 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    optionSelected: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    optionDisabled: {
      opacity: 0.56,
    },
    optionPressed: {
      opacity: 0.88,
    },
    optionMain: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    iconWrap: {
      width: 30,
      height: 30,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgItem,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    iconWrapSelected: {
      backgroundColor: theme.colors.bgCanvasAccent,
      borderColor: theme.colors.border,
    },
    iconWrapDanger: {
      backgroundColor: theme.colors.errorBg,
      borderColor: theme.colors.error,
    },
    copy: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs + 2,
    },
    optionTitle: {
      ...theme.typography.body,
      flex: 1,
      color: theme.colors.textSecondary,
      fontWeight: '600',
      lineHeight: 18,
    },
    optionTitleSelected: {
      color: theme.colors.textPrimary,
    },
    optionDescription: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      lineHeight: 15,
    },
    badge: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
      paddingHorizontal: theme.spacing.xs + 4,
      paddingVertical: 2,
    },
    badgeText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 10,
      lineHeight: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    accessory: {
      flexShrink: 0,
      alignItems: 'flex-end',
      gap: 6,
    },
    meta: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '600',
    },
    footer: {
      alignItems: 'flex-end',
    },
    closeButton: {
      minWidth: 88,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm + 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeButtonPressed: {
      opacity: 0.86,
    },
    closeText: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
  });
