import {
  ALL_CHAT_ENGINES,
  getChatEngineLabel,
  getChatEngineMetadata,
  normalizeChatEngine,
  resolveChatEngine,
} from '../chatEngines';

describe('chatEngines', () => {
  it('includes t3code in the known engine catalog', () => {
    expect(ALL_CHAT_ENGINES).toContain('t3code');
  });

  it('normalizes and resolves t3code without falling back to codex', () => {
    expect(normalizeChatEngine('t3code')).toBe('t3code');
    expect(resolveChatEngine('t3code')).toBe('t3code');
  });

  it('returns the correct metadata for t3code', () => {
    expect(getChatEngineLabel('t3code')).toBe('T3 Code');
    expect(getChatEngineMetadata('t3code')).toMatchObject({
      id: 't3code',
      label: 'T3 Code',
      icon: 'code-slash-outline',
    });
  });
});
