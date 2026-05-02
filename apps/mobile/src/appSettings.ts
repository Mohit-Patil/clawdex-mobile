import type {
  ApprovalMode,
  ChatEngine,
  EngineDefaultSettingsMap,
  ReasoningEffort,
} from './api/types';
import { dedupeRecentPreviewTargets, normalizePreviewTargetInput } from './browserPreview';
import { normalizeBridgeUrlInput } from './bridgeUrl';
import {
  DEFAULT_FONT_PREFERENCE,
  normalizeFontPreference,
  type FontPreference,
} from './fonts';
import type { AppearancePreference, DarkUiPalette } from './theme';

export const APP_SETTINGS_VERSION = 10;
export const DEFAULT_WORKSPACE_CHAT_LIMIT = 5;
export const WORKSPACE_CHAT_LIMIT_OPTIONS = [5, 10, 25, null] as const;
export type WorkspaceChatLimit = (typeof WORKSPACE_CHAT_LIMIT_OPTIONS)[number];

export function parseAppSettings(raw: string): {
  bridgeUrl: string | null;
  bridgeToken: string | null;
  defaultStartCwd: string | null;
  defaultChatEngine: ChatEngine;
  defaultEngineSettings: EngineDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  appearancePreference: AppearancePreference;
  darkUiPalette: DarkUiPalette;
  fontPreference: FontPreference;
  workspaceChatLimit: WorkspaceChatLimit;
  recentBrowserTargetUrls: string[];
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      defaultChatEngine: 'codex',
      defaultEngineSettings: createEmptyEngineDefaultSettingsMap(),
      approvalMode: 'yolo',
      showToolCalls: true,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
      recentBrowserTargetUrls: [],
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedVersion = (parsed as { version?: unknown }).version;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsedVersion !== 1 &&
        parsedVersion !== 2 &&
        parsedVersion !== 3 &&
        parsedVersion !== 4 &&
        parsedVersion !== 5 &&
        parsedVersion !== 6 &&
        parsedVersion !== 7 &&
        parsedVersion !== 8 &&
        parsedVersion !== 9 &&
        parsedVersion !== APP_SETTINGS_VERSION)
    ) {
      return {
        bridgeUrl: null,
        bridgeToken: null,
        defaultStartCwd: null,
        defaultChatEngine: 'codex',
        defaultEngineSettings: createEmptyEngineDefaultSettingsMap(),
        approvalMode: 'yolo',
        showToolCalls: true,
        appearancePreference: 'system',
        darkUiPalette: 'classic',
        fontPreference: DEFAULT_FONT_PREFERENCE,
        workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
        recentBrowserTargetUrls: [],
      };
    }

    const legacyDefaultModelId = normalizeModelId(
      (parsed as { defaultModelId?: unknown }).defaultModelId
    );
    const legacyDefaultReasoningEffort = normalizeReasoningEffort(
      (parsed as { defaultReasoningEffort?: unknown }).defaultReasoningEffort
    );
    const defaultChatEngine =
      normalizeChatEngine((parsed as { defaultChatEngine?: unknown }).defaultChatEngine) ??
      inferChatEngineFromModelId(legacyDefaultModelId) ??
      'codex';
    const defaultEngineSettings = normalizeEngineDefaultSettingsMap(
      (parsed as { defaultEngineSettings?: unknown }).defaultEngineSettings,
      legacyDefaultModelId,
      legacyDefaultReasoningEffort
    );

    return {
      bridgeUrl: normalizeBridgeUrl((parsed as { bridgeUrl?: unknown }).bridgeUrl),
      bridgeToken: normalizeBridgeToken((parsed as { bridgeToken?: unknown }).bridgeToken),
      defaultStartCwd: normalizeDefaultStartCwd(
        (parsed as { defaultStartCwd?: unknown }).defaultStartCwd
      ),
      defaultChatEngine,
      defaultEngineSettings,
      approvalMode: normalizeStoredApprovalMode(
        (parsed as { approvalMode?: unknown }).approvalMode
      ),
      showToolCalls:
        typeof (parsed as { showToolCalls?: unknown }).showToolCalls === 'undefined'
          ? true
          : normalizeBoolean((parsed as { showToolCalls?: unknown }).showToolCalls),
      appearancePreference: normalizeStoredAppearancePreference(
        (parsed as { appearancePreference?: unknown }).appearancePreference,
        parsedVersion === 4 ? 'dark' : 'system'
      ),
      darkUiPalette: normalizeStoredDarkUiPalette(
        (parsed as { darkUiPalette?: unknown }).darkUiPalette
      ),
      fontPreference: normalizeFontPreference(
        (parsed as { fontPreference?: unknown }).fontPreference
      ),
      workspaceChatLimit: normalizeWorkspaceChatLimit(
        (parsed as { workspaceChatLimit?: unknown }).workspaceChatLimit
      ),
      recentBrowserTargetUrls: normalizeBrowserTargetUrls(
        (parsed as { recentBrowserTargetUrls?: unknown }).recentBrowserTargetUrls
      ),
    };
  } catch {
    return {
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      defaultChatEngine: 'codex',
      defaultEngineSettings: createEmptyEngineDefaultSettingsMap(),
      approvalMode: 'yolo',
      showToolCalls: true,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
      recentBrowserTargetUrls: [],
    };
  }
}

export function formatWorkspaceChatLimit(value: WorkspaceChatLimit): string {
  return value === null ? 'All chats' : `${value} chats`;
}

function normalizeBridgeUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return normalizeBridgeUrlInput(value);
}

function normalizeBridgeToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDefaultStartCwd(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceChatLimit(value: unknown): WorkspaceChatLimit {
  if (value === null || value === 'all') {
    return null;
  }

  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  return numericValue === 10 || numericValue === 25
    ? numericValue
    : numericValue === 5
      ? 5
      : DEFAULT_WORKSPACE_CHAT_LIMIT;
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeChatEngine(value: unknown): ChatEngine | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'opencode' || normalized === 'cursor') {
    return normalized;
  }

  return null;
}

function inferChatEngineFromModelId(value: string | null | undefined): ChatEngine | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return null;
  }

  return normalized.includes('/') ? 'opencode' : 'codex';
}

function createEmptyEngineDefaultSettingsMap(): EngineDefaultSettingsMap {
  return {
    codex: {
      modelId: null,
      effort: null,
    },
    opencode: {
      modelId: null,
      effort: null,
    },
    cursor: {
      modelId: null,
      effort: null,
    },
  };
}

function normalizeEngineDefaultSettingsMap(
  value: unknown,
  legacyDefaultModelId: string | null,
  legacyDefaultEffort: ReasoningEffort | null
): EngineDefaultSettingsMap {
  const base = createEmptyEngineDefaultSettingsMap();
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

  for (const engine of ['codex', 'opencode', 'cursor'] as const) {
    const entry =
      record && typeof record[engine] === 'object'
        ? (record[engine] as Record<string, unknown>)
        : null;
    if (!entry) {
      continue;
    }

    base[engine] = {
      modelId: normalizeModelId(entry.modelId),
      effort: normalizeReasoningEffort(entry.effort),
    };
  }

  if (legacyDefaultModelId) {
    const legacyEngine = inferChatEngineFromModelId(legacyDefaultModelId) ?? 'codex';
    base[legacyEngine] = {
      modelId: legacyDefaultModelId,
      effort: legacyDefaultEffort,
    };
  }

  return base;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }

  return null;
}

function normalizeBrowserTargetUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeRecentPreviewTargets(
    value
      .map((entry) => (typeof entry === 'string' ? normalizePreviewTargetInput(entry) : null))
      .filter((entry): entry is string => typeof entry === 'string')
  );
}

function normalizeStoredApprovalMode(value: unknown): ApprovalMode {
  if (typeof value === 'undefined') {
    return 'yolo';
  }

  return value === 'yolo' ? 'yolo' : 'normal';
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeStoredDarkUiPalette(value: unknown): DarkUiPalette {
  return value === 'grey' ? 'grey' : 'classic';
}

function normalizeStoredAppearancePreference(
  value: unknown,
  fallback: AppearancePreference
): AppearancePreference {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : fallback;
}
