import { spacing } from '../theme';

const IOS_HOME_INDICATOR_THRESHOLD = 20;
const ANDROID_NAV_BUTTONS_THRESHOLD = 16;

export interface ComposerBottomSpacing {
  baseBottomPadding: number;
  extraBottomInset: number;
  totalBottomPadding: number;
}

export function resolveComposerBottomSpacing(
  platform: string,
  safeAreaBottomInset: number,
  keyboardVisible: boolean
): ComposerBottomSpacing {
  const normalizedInset = Number.isFinite(safeAreaBottomInset)
    ? Math.max(0, safeAreaBottomInset)
    : 0;

  const baseBottomPadding = resolveBaseBottomPadding(platform, keyboardVisible);
  const extraBottomInset = keyboardVisible
    ? 0
    : resolveRestingBottomInset(platform, normalizedInset);

  return {
    baseBottomPadding,
    extraBottomInset,
    totalBottomPadding: baseBottomPadding + extraBottomInset,
  };
}

function resolveBaseBottomPadding(platform: string, keyboardVisible: boolean): number {
  if (platform === 'ios') {
    return keyboardVisible ? 2 : spacing.xs + 2;
  }

  if (platform === 'android') {
    return keyboardVisible ? 0 : spacing.sm;
  }

  return keyboardVisible ? 0 : spacing.sm;
}

function resolveRestingBottomInset(platform: string, safeAreaBottomInset: number): number {
  if (platform === 'ios') {
    return safeAreaBottomInset >= IOS_HOME_INDICATOR_THRESHOLD ? spacing.sm : 0;
  }

  if (platform === 'android') {
    if (safeAreaBottomInset >= ANDROID_NAV_BUTTONS_THRESHOLD) {
      return spacing.sm;
    }

    return safeAreaBottomInset > 0 ? 2 : 0;
  }

  return safeAreaBottomInset;
}
