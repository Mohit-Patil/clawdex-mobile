import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { normalizeBridgeUrlInput } from './bridgeUrl';

const BRIDGE_PROFILE_STORE_KEY = 'clawdex.bridge-profiles.v1';
let bridgeProfileStoreMemoryFallback: string | null = null;

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BridgeProfile {
  id: string;
  name: string;
  bridgeUrl: string;
  bridgeToken: string;
  authMode: BridgeProfileAuthMode;
  githubUserLogin: string | null;
  githubCodespaceName: string | null;
  githubRepositoryFullName: string | null;
  githubRefreshToken: string | null;
  githubAccessTokenExpiresAt: string | null;
  githubRefreshTokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BridgeProfileAuthMode = 'bridgeToken' | 'githubApp';

export interface BridgeProfileStore {
  activeProfileId: string | null;
  profiles: BridgeProfile[];
}

export interface BridgeProfileDraft {
  id?: string | null;
  name?: string | null;
  bridgeUrl: string;
  bridgeToken: string;
  authMode?: BridgeProfileAuthMode | null;
  githubUserLogin?: string | null;
  githubCodespaceName?: string | null;
  githubRepositoryFullName?: string | null;
  githubRefreshToken?: string | null;
  githubAccessTokenExpiresAt?: string | null;
  githubRefreshTokenExpiresAt?: string | null;
  activate?: boolean;
}

export function createEmptyBridgeProfileStore(): BridgeProfileStore {
  return {
    activeProfileId: null,
    profiles: [],
  };
}

export function parseBridgeProfileStore(raw: string | null | undefined): BridgeProfileStore {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return createEmptyBridgeProfileStore();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyBridgeProfileStore();
    }

    const record = parsed as {
      activeProfileId?: unknown;
      profiles?: unknown;
    };
    const profiles = Array.isArray(record.profiles)
      ? record.profiles
          .map((entry) => normalizeBridgeProfile(entry))
          .filter((entry): entry is BridgeProfile => entry !== null)
      : [];
    const activeProfileId =
      typeof record.activeProfileId === 'string' &&
      profiles.some((profile) => profile.id === record.activeProfileId)
        ? record.activeProfileId
        : null;

    return {
      activeProfileId,
      profiles,
    };
  } catch {
    return createEmptyBridgeProfileStore();
  }
}

export async function loadBridgeProfileStore(): Promise<BridgeProfileStore> {
  try {
    const raw = await readBridgeProfileStoreRaw();
    return parseBridgeProfileStore(raw);
  } catch {
    return createEmptyBridgeProfileStore();
  }
}

export async function saveBridgeProfileStore(store: BridgeProfileStore): Promise<void> {
  const sanitized = sanitizeBridgeProfileStore(store);
  const raw = JSON.stringify(sanitized);
  await writeBridgeProfileStoreRaw(raw);
}

export async function clearBridgeProfileStore(): Promise<void> {
  await deleteBridgeProfileStoreRaw();
}

export function upsertBridgeProfile(
  store: BridgeProfileStore,
  draft: BridgeProfileDraft
): { profile: BridgeProfile; store: BridgeProfileStore } {
  const normalizedUrl = normalizeBridgeUrlInput(draft.bridgeUrl);
  const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
  if (!normalizedUrl || !normalizedToken) {
    throw new Error('Bridge URL and token are required.');
  }

  const existing = draft.id
    ? store.profiles.find((profile) => profile.id === draft.id) ?? null
    : null;
  const now = new Date().toISOString();
  const profileId = existing?.id ?? createBridgeProfileId();
  const resolvedName = deriveBridgeProfileName(draft.name, normalizedUrl);
  const nextProfile: BridgeProfile = {
    id: profileId,
    name: resolvedName,
    bridgeUrl: normalizedUrl,
    bridgeToken: normalizedToken,
    authMode: normalizeBridgeProfileAuthMode(draft.authMode) ?? existing?.authMode ?? 'bridgeToken',
    githubUserLogin:
      normalizeOptionalMetadataValue(draft.githubUserLogin) ?? existing?.githubUserLogin ?? null,
    githubCodespaceName:
      normalizeOptionalMetadataValue(draft.githubCodespaceName) ??
      existing?.githubCodespaceName ??
      null,
    githubRepositoryFullName:
      normalizeOptionalMetadataValue(draft.githubRepositoryFullName) ??
      existing?.githubRepositoryFullName ??
      null,
    githubRefreshToken:
      normalizeOptionalMetadataValue(draft.githubRefreshToken) ??
      existing?.githubRefreshToken ??
      null,
    githubAccessTokenExpiresAt:
      normalizeOptionalTimestamp(draft.githubAccessTokenExpiresAt) ??
      existing?.githubAccessTokenExpiresAt ??
      null,
    githubRefreshTokenExpiresAt:
      normalizeOptionalTimestamp(draft.githubRefreshTokenExpiresAt) ??
      existing?.githubRefreshTokenExpiresAt ??
      null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const nextProfiles = [...store.profiles];
  const existingIndex = nextProfiles.findIndex((profile) => profile.id === profileId);
  if (existingIndex >= 0) {
    nextProfiles[existingIndex] = nextProfile;
  } else {
    nextProfiles.push(nextProfile);
  }

  const nextStore = sanitizeBridgeProfileStore({
    activeProfileId: draft.activate === false ? store.activeProfileId : profileId,
    profiles: nextProfiles,
  });

  return {
    profile: nextProfile,
    store: nextStore,
  };
}

export function setActiveBridgeProfile(
  store: BridgeProfileStore,
  profileId: string | null
): BridgeProfileStore {
  if (profileId === null) {
    return {
      ...store,
      activeProfileId: null,
    };
  }

  if (!store.profiles.some((profile) => profile.id === profileId)) {
    return sanitizeBridgeProfileStore(store);
  }

  return {
    ...store,
    activeProfileId: profileId,
  };
}

export function renameBridgeProfile(
  store: BridgeProfileStore,
  profileId: string,
  nextName: string | null | undefined
): BridgeProfileStore {
  const existing = store.profiles.find((profile) => profile.id === profileId);
  if (!existing) {
    return sanitizeBridgeProfileStore(store);
  }

  const updatedAt = new Date().toISOString();
  return sanitizeBridgeProfileStore({
    ...store,
    profiles: store.profiles.map((profile) =>
      profile.id === profileId
        ? {
            ...profile,
            name: deriveBridgeProfileName(nextName, profile.bridgeUrl),
            updatedAt,
          }
        : profile
    ),
  });
}

export function removeBridgeProfile(
  store: BridgeProfileStore,
  profileId: string
): BridgeProfileStore {
  const nextProfiles = store.profiles.filter((profile) => profile.id !== profileId);
  const nextActiveProfileId =
    store.activeProfileId === profileId ? nextProfiles[0]?.id ?? null : store.activeProfileId;

  return sanitizeBridgeProfileStore({
    activeProfileId: nextActiveProfileId,
    profiles: nextProfiles,
  });
}

export function getActiveBridgeProfile(
  store: BridgeProfileStore
): BridgeProfile | null {
  if (!store.activeProfileId) {
    return null;
  }

  return store.profiles.find((profile) => profile.id === store.activeProfileId) ?? null;
}

export function deriveBridgeProfileName(
  value: string | null | undefined,
  bridgeUrl: string
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > 0) {
    return trimmed;
  }

  try {
    const parsed = new URL(bridgeUrl);
    const host = parsed.hostname.trim();
    return host.length > 0 ? host : 'Bridge';
  } catch {
    return 'Bridge';
  }
}

function sanitizeBridgeProfileStore(store: BridgeProfileStore): BridgeProfileStore {
  const profiles = Array.isArray(store.profiles)
    ? store.profiles
        .map((entry) => normalizeBridgeProfile(entry))
        .filter((entry): entry is BridgeProfile => entry !== null)
    : [];
  const activeProfileId =
    typeof store.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === store.activeProfileId)
      ? store.activeProfileId
      : null;

  return {
    activeProfileId,
    profiles,
  };
}

function normalizeBridgeProfile(value: unknown): BridgeProfile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as {
    id?: unknown;
    name?: unknown;
    bridgeUrl?: unknown;
    bridgeToken?: unknown;
    authMode?: unknown;
    githubUserLogin?: unknown;
    githubCodespaceName?: unknown;
    githubRepositoryFullName?: unknown;
    githubRefreshToken?: unknown;
    githubAccessTokenExpiresAt?: unknown;
    githubRefreshTokenExpiresAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  const id = normalizeNonEmptyString(record.id);
  const bridgeUrl =
    typeof record.bridgeUrl === 'string'
      ? normalizeBridgeUrlInput(record.bridgeUrl)
      : null;
  const bridgeToken = normalizeBridgeToken(record.bridgeToken);
  const authMode =
    typeof record.authMode === 'undefined'
      ? 'bridgeToken'
      : normalizeBridgeProfileAuthMode(record.authMode);
  if (!id || !bridgeUrl || !bridgeToken || !authMode) {
    return null;
  }

  return {
    id,
    name: deriveBridgeProfileName(normalizeNonEmptyString(record.name), bridgeUrl),
    bridgeUrl,
    bridgeToken,
    authMode,
    githubUserLogin: normalizeOptionalMetadataValue(record.githubUserLogin),
    githubCodespaceName: normalizeOptionalMetadataValue(record.githubCodespaceName),
    githubRepositoryFullName: normalizeOptionalMetadataValue(record.githubRepositoryFullName),
    githubRefreshToken: normalizeOptionalMetadataValue(record.githubRefreshToken),
    githubAccessTokenExpiresAt: normalizeOptionalTimestamp(record.githubAccessTokenExpiresAt),
    githubRefreshTokenExpiresAt: normalizeOptionalTimestamp(record.githubRefreshTokenExpiresAt),
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
  };
}

function normalizeBridgeProfileAuthMode(value: unknown): BridgeProfileAuthMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (normalized === 'bridgeToken' || normalized === 'githubApp') {
    return normalized;
  }

  return null;
}

export function isGitHubBridgeAuthMode(value: unknown): value is Extract<
  BridgeProfileAuthMode,
  'githubApp'
> {
  const normalized = normalizeBridgeProfileAuthMode(value);
  return normalized === 'githubApp';
}

export function isGitHubBridgeProfile(
  profile: Pick<BridgeProfile, 'authMode'> | null | undefined
): boolean {
  return isGitHubBridgeAuthMode(profile?.authMode);
}

function normalizeOptionalMetadataValue(value: unknown): string | null {
  return normalizeNonEmptyString(value);
}

function normalizeBridgeToken(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestamp(value: unknown): string {
  const normalized = normalizeNonEmptyString(value);
  return normalized ?? new Date().toISOString();
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  return normalizeNonEmptyString(value);
}

function createBridgeProfileId(): string {
  return `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readBridgeProfileStoreRaw(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return readBridgeProfileStoreRawFromWeb();
  }

  return SecureStore.getItemAsync(BRIDGE_PROFILE_STORE_KEY);
}

async function writeBridgeProfileStoreRaw(raw: string): Promise<void> {
  if (Platform.OS === 'web') {
    writeBridgeProfileStoreRawToWeb(raw);
    return;
  }

  await SecureStore.setItemAsync(BRIDGE_PROFILE_STORE_KEY, raw, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

async function deleteBridgeProfileStoreRaw(): Promise<void> {
  if (Platform.OS === 'web') {
    deleteBridgeProfileStoreRawFromWeb();
    return;
  }

  await SecureStore.deleteItemAsync(BRIDGE_PROFILE_STORE_KEY);
}

function readBridgeProfileStoreRawFromWeb(): string | null {
  const storage = getWebStorage();
  if (!storage) {
    return bridgeProfileStoreMemoryFallback;
  }

  try {
    const raw = storage.getItem(BRIDGE_PROFILE_STORE_KEY);
    return raw ?? bridgeProfileStoreMemoryFallback;
  } catch {
    return bridgeProfileStoreMemoryFallback;
  }
}

function writeBridgeProfileStoreRawToWeb(raw: string): void {
  bridgeProfileStoreMemoryFallback = raw;
  const storage = getWebStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(BRIDGE_PROFILE_STORE_KEY, raw);
  } catch {
    // Ignore web storage write failures and keep the in-memory fallback.
  }
}

function deleteBridgeProfileStoreRawFromWeb(): void {
  bridgeProfileStoreMemoryFallback = null;
  const storage = getWebStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(BRIDGE_PROFILE_STORE_KEY);
  } catch {
    // Ignore web storage delete failures and clear the in-memory fallback.
  }
}

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) {
    return null;
  }

  const storage = (
    globalThis as typeof globalThis & {
      localStorage?: Partial<WebStorageLike> | undefined;
    }
  ).localStorage;

  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    return null;
  }

  return storage as WebStorageLike;
}
