import * as FileSystem from 'expo-file-system/legacy';

/**
 * Saved-prompt library.
 *
 * Power users re-issue the same instructions to the agent constantly, and
 * typing long prompts on a phone keyboard is slow. This module persists a
 * small set of reusable prompt templates that the composer can insert with a
 * single tap. It follows the same file-backed JSON persistence pattern as
 * `storeReview.ts` (no native secrets involved, so no SecureStore needed).
 */

export const PROMPT_LIBRARY_VERSION = 1;

const PROMPT_LIBRARY_FILE = 'clawdex-prompt-library.json';

export const MAX_PROMPT_TITLE_LENGTH = 80;
export const MAX_PROMPT_BODY_LENGTH = 4000;
export const MAX_SAVED_PROMPTS = 100;

export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptLibraryStore {
  version: number;
  prompts: SavedPrompt[];
}

export interface SavedPromptDraft {
  id?: string | null;
  title?: string | null;
  body: string;
}

/**
 * Seed prompts shown the first time a user opens the library. They double as
 * usage examples so an empty library never feels broken.
 */
export function createDefaultPrompts(now: string): SavedPrompt[] {
  const seeds: Array<{ title: string; body: string }> = [
    {
      title: 'Run tests and fix failures',
      body: 'Run the full test suite. If anything fails, diagnose the root cause and fix it, then re-run the tests to confirm they pass.',
    },
    {
      title: 'Review my changes',
      body: 'Review the uncommitted changes for correctness, security, and edge cases. List concrete issues with file and line references, then propose fixes.',
    },
    {
      title: 'Explain this codebase',
      body: 'Give me a concise tour of this codebase: the entry points, the main modules, how they fit together, and where the core business logic lives.',
    },
    {
      title: 'Write a commit message',
      body: 'Write a clear conventional-commit message for the currently staged changes. Keep the subject under 72 characters and summarize the why in the body.',
    },
  ];

  return seeds.map((seed, index) => ({
    id: `seed-${String(index + 1)}`,
    title: seed.title,
    body: seed.body,
    createdAt: now,
    updatedAt: now,
  }));
}

export function createEmptyPromptLibraryStore(): PromptLibraryStore {
  return { version: PROMPT_LIBRARY_VERSION, prompts: [] };
}

function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeStoredPrompt(value: unknown): SavedPrompt | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const body = clampText(record.body, MAX_PROMPT_BODY_LENGTH);
  if (id.length === 0 || body.length === 0) {
    return null;
  }
  const title = clampText(record.title, MAX_PROMPT_TITLE_LENGTH);
  const createdAt =
    typeof record.createdAt === 'string' && record.createdAt.trim().length > 0
      ? record.createdAt
      : '';
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim().length > 0
      ? record.updatedAt
      : createdAt;
  return {
    id,
    title: title.length > 0 ? title : deriveTitleFromBody(body),
    body,
    createdAt,
    updatedAt,
  };
}

/** Use the first line of the body as a fallback title when none is provided. */
export function deriveTitleFromBody(body: string): string {
  const firstLine = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return clampText(firstLine, MAX_PROMPT_TITLE_LENGTH);
}

export function parsePromptLibrary(raw: string): PromptLibraryStore {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return createEmptyPromptLibraryStore();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyPromptLibraryStore();
    }
    const rawPrompts = (parsed as { prompts?: unknown }).prompts;
    if (!Array.isArray(rawPrompts)) {
      return createEmptyPromptLibraryStore();
    }
    const seen = new Set<string>();
    const prompts: SavedPrompt[] = [];
    for (const entry of rawPrompts) {
      const normalized = normalizeStoredPrompt(entry);
      if (!normalized || seen.has(normalized.id)) {
        continue;
      }
      seen.add(normalized.id);
      prompts.push(normalized);
      if (prompts.length >= MAX_SAVED_PROMPTS) {
        break;
      }
    }
    return { version: PROMPT_LIBRARY_VERSION, prompts };
  } catch {
    return createEmptyPromptLibraryStore();
  }
}

export function serializePromptLibrary(store: PromptLibraryStore): string {
  return JSON.stringify({
    version: PROMPT_LIBRARY_VERSION,
    prompts: store.prompts,
  });
}

export function createPromptId(now: string, seed: number): string {
  const suffix = Math.max(0, Math.floor(seed)).toString(36);
  return `prompt-${now.replace(/[^0-9a-zA-Z]/g, '')}-${suffix}`;
}

/**
 * Insert or update a prompt. When the draft has an `id` that already exists the
 * matching prompt is updated in place (preserving `createdAt`); otherwise a new
 * prompt is prepended so the most recently added is shown first.
 */
export function upsertPrompt(
  store: PromptLibraryStore,
  draft: SavedPromptDraft,
  now: string,
  idSeed: number
): PromptLibraryStore {
  const body = clampText(draft.body, MAX_PROMPT_BODY_LENGTH);
  if (body.length === 0) {
    return store;
  }
  const rawTitle = clampText(draft.title, MAX_PROMPT_TITLE_LENGTH);
  const title = rawTitle.length > 0 ? rawTitle : deriveTitleFromBody(body);

  const existingId = typeof draft.id === 'string' ? draft.id.trim() : '';
  if (existingId.length > 0) {
    const index = store.prompts.findIndex((prompt) => prompt.id === existingId);
    if (index >= 0) {
      const existing = store.prompts[index];
      const updated: SavedPrompt = {
        ...existing,
        title,
        body,
        updatedAt: now,
      };
      const nextPrompts = store.prompts.slice();
      nextPrompts[index] = updated;
      return { version: PROMPT_LIBRARY_VERSION, prompts: nextPrompts };
    }
  }

  const created: SavedPrompt = {
    id: createPromptId(now, idSeed),
    title,
    body,
    createdAt: now,
    updatedAt: now,
  };
  const nextPrompts = [created, ...store.prompts].slice(0, MAX_SAVED_PROMPTS);
  return { version: PROMPT_LIBRARY_VERSION, prompts: nextPrompts };
}

export function removePrompt(
  store: PromptLibraryStore,
  promptId: string
): PromptLibraryStore {
  const target = typeof promptId === 'string' ? promptId.trim() : '';
  if (target.length === 0) {
    return store;
  }
  const nextPrompts = store.prompts.filter((prompt) => prompt.id !== target);
  if (nextPrompts.length === store.prompts.length) {
    return store;
  }
  return { version: PROMPT_LIBRARY_VERSION, prompts: nextPrompts };
}

/** Case-insensitive search across both title and body. */
export function filterPrompts(prompts: SavedPrompt[], query: string): SavedPrompt[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) {
    return prompts;
  }
  return prompts.filter((prompt) => {
    return (
      prompt.title.toLowerCase().includes(needle) ||
      prompt.body.toLowerCase().includes(needle)
    );
  });
}

function getPromptLibraryPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${PROMPT_LIBRARY_FILE}`;
}

export async function loadPromptLibrary(): Promise<PromptLibraryStore> {
  const path = getPromptLibraryPath();
  if (!path) {
    return { version: PROMPT_LIBRARY_VERSION, prompts: createDefaultPrompts(isoNow()) };
  }
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    // A persisted file is authoritative — respect it even when the user has
    // deleted every prompt, so we never resurrect the seed examples.
    return parsePromptLibrary(raw);
  } catch {
    // No library file yet: seed the example prompts and persist them so this
    // first-run set only ever appears once.
    const seeded = { version: PROMPT_LIBRARY_VERSION, prompts: createDefaultPrompts(isoNow()) };
    try {
      await savePromptLibrary(seeded);
    } catch {
      // Ignore persistence failures; the in-memory seeds are still usable.
    }
    return seeded;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

export async function savePromptLibrary(store: PromptLibraryStore): Promise<void> {
  const path = getPromptLibraryPath();
  if (!path) {
    return;
  }
  await FileSystem.writeAsStringAsync(path, serializePromptLibrary(store));
}
