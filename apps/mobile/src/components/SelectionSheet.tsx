import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '../theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type OptionTone = 'default' | 'accent' | 'danger';

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
}: SelectionSheetProps) {
  const insets = useSafeAreaInsets();

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
            { paddingBottom: Math.max(insets.bottom, spacing.md) },
          ]}
        >
          <View style={styles.sheetCard}>
            <View style={styles.handle} />

            <View style={styles.header}>
              {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
              <Text style={styles.title}>{title}</Text>
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={2}>
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
                style={styles.list}
                contentContainerStyle={styles.listContent}
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
  },
  sheetOuter: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
  },
  sheetCard: {
    maxHeight: '82%',
    borderRadius: 24,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.09)',
    backgroundColor: '#07090C',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    gap: spacing.md,
    boxShadow: '0 -10px 34px rgba(0, 0, 0, 0.42)',
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  header: {
    gap: 4,
  },
  eyebrow: {
    ...typography.caption,
    color: 'rgba(232, 236, 244, 0.58)',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    ...typography.headline,
    color: colors.textPrimary,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
  },
  subtitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  list: {
    maxHeight: 420,
  },
  listContent: {
    gap: spacing.sm,
  },
  loadingState: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingLabel: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  option: {
    minHeight: 64,
    borderRadius: 18,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#0D1014',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  optionSelected: {
    borderColor: 'rgba(255, 255, 255, 0.22)',
    backgroundColor: '#141920',
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
    gap: spacing.sm,
  },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#171C22',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  iconWrapSelected: {
    backgroundColor: '#1C232C',
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  iconWrapDanger: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.24)',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  optionTitle: {
    ...typography.body,
    flex: 1,
    color: colors.textSecondary,
    fontWeight: '600',
    lineHeight: 18,
  },
  optionTitleSelected: {
    color: colors.textPrimary,
  },
  optionDescription: {
    ...typography.caption,
    color: 'rgba(232, 236, 244, 0.62)',
    lineHeight: 15,
  },
  badge: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    backgroundColor: '#11151A',
    paddingHorizontal: spacing.xs + 4,
    paddingVertical: 2,
  },
  badgeText: {
    ...typography.caption,
    color: colors.textMuted,
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
    ...typography.caption,
    color: colors.textMuted,
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
    borderColor: 'rgba(255, 255, 255, 0.1)',
    backgroundColor: '#101318',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonPressed: {
    opacity: 0.86,
  },
  closeText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
});
