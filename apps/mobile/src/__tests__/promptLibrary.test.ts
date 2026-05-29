import {
  createDefaultPrompts,
  createEmptyPromptLibraryStore,
  createPromptId,
  deriveTitleFromBody,
  filterPrompts,
  MAX_PROMPT_BODY_LENGTH,
  MAX_SAVED_PROMPTS,
  parsePromptLibrary,
  PROMPT_LIBRARY_VERSION,
  removePrompt,
  serializePromptLibrary,
  upsertPrompt,
} from '../promptLibrary';

const NOW = '2026-05-29T12:00:00.000Z';

describe('promptLibrary', () => {
  it('returns an empty store for blank or malformed input', () => {
    expect(parsePromptLibrary('').prompts).toEqual([]);
    expect(parsePromptLibrary('not json').prompts).toEqual([]);
    expect(parsePromptLibrary('{"prompts": "nope"}').prompts).toEqual([]);
  });

  it('round-trips through serialize/parse', () => {
    const seeded = { version: PROMPT_LIBRARY_VERSION, prompts: createDefaultPrompts(NOW) };
    const restored = parsePromptLibrary(serializePromptLibrary(seeded));
    expect(restored.prompts).toEqual(seeded.prompts);
  });

  it('drops entries with empty bodies and de-duplicates ids', () => {
    const raw = JSON.stringify({
      version: PROMPT_LIBRARY_VERSION,
      prompts: [
        { id: 'a', title: 'Keep', body: 'Do the thing', createdAt: NOW, updatedAt: NOW },
        { id: 'b', title: 'Empty', body: '   ', createdAt: NOW, updatedAt: NOW },
        { id: 'a', title: 'Duplicate', body: 'Different body', createdAt: NOW, updatedAt: NOW },
      ],
    });
    const parsed = parsePromptLibrary(raw);
    expect(parsed.prompts).toHaveLength(1);
    expect(parsed.prompts[0]).toMatchObject({ id: 'a', title: 'Keep' });
  });

  it('falls back to the first non-empty body line when title is missing', () => {
    expect(deriveTitleFromBody('\n  First line  \nSecond')).toBe('First line');
    const raw = JSON.stringify({
      prompts: [{ id: 'x', body: 'Implicit title here', createdAt: NOW, updatedAt: NOW }],
    });
    expect(parsePromptLibrary(raw).prompts[0].title).toBe('Implicit title here');
  });

  it('prepends new prompts on upsert', () => {
    let store = createEmptyPromptLibraryStore();
    store = upsertPrompt(store, { title: 'One', body: 'First' }, NOW, 1);
    store = upsertPrompt(store, { title: 'Two', body: 'Second' }, NOW, 2);
    expect(store.prompts.map((p) => p.title)).toEqual(['Two', 'One']);
  });

  it('updates an existing prompt in place and preserves createdAt', () => {
    let store = upsertPrompt(createEmptyPromptLibraryStore(), { title: 'Orig', body: 'Body' }, NOW, 7);
    const { id, createdAt } = store.prompts[0];
    const later = '2026-06-01T09:00:00.000Z';
    store = upsertPrompt(store, { id, title: 'Edited', body: 'New body' }, later, 7);
    expect(store.prompts).toHaveLength(1);
    expect(store.prompts[0]).toMatchObject({
      id,
      title: 'Edited',
      body: 'New body',
      createdAt,
      updatedAt: later,
    });
  });

  it('ignores upserts with an empty body', () => {
    const store = upsertPrompt(createEmptyPromptLibraryStore(), { body: '   ' }, NOW, 1);
    expect(store.prompts).toEqual([]);
  });

  it('clamps an over-long body', () => {
    const long = 'x'.repeat(MAX_PROMPT_BODY_LENGTH + 50);
    const store = upsertPrompt(createEmptyPromptLibraryStore(), { title: 'L', body: long }, NOW, 1);
    expect(store.prompts[0].body).toHaveLength(MAX_PROMPT_BODY_LENGTH);
  });

  it('caps the total number of stored prompts', () => {
    let store = createEmptyPromptLibraryStore();
    for (let i = 0; i < MAX_SAVED_PROMPTS + 10; i += 1) {
      store = upsertPrompt(store, { title: `P${String(i)}`, body: `Body ${String(i)}` }, NOW, i);
    }
    expect(store.prompts).toHaveLength(MAX_SAVED_PROMPTS);
  });

  it('removes by id and is a no-op for unknown ids', () => {
    let store = upsertPrompt(createEmptyPromptLibraryStore(), { title: 'A', body: 'a' }, NOW, 1);
    const { id } = store.prompts[0];
    expect(removePrompt(store, 'missing')).toBe(store);
    store = removePrompt(store, id);
    expect(store.prompts).toEqual([]);
  });

  it('filters case-insensitively across title and body', () => {
    const prompts = createDefaultPrompts(NOW);
    expect(filterPrompts(prompts, '')).toBe(prompts);
    expect(filterPrompts(prompts, 'COMMIT').some((p) => /commit/i.test(p.title))).toBe(true);
    expect(filterPrompts(prompts, 'security').length).toBeGreaterThan(0);
    expect(filterPrompts(prompts, 'zzzz-no-match')).toEqual([]);
  });

  it('creates collision-resistant ids from distinct seeds', () => {
    expect(createPromptId(NOW, 1)).not.toBe(createPromptId(NOW, 2));
    expect(createPromptId(NOW, 5)).toMatch(/^prompt-/);
  });
});
