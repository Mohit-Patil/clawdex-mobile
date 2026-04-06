import type { ChatSummary } from '../../api/types';
import {
  DEFAULT_DRAWER_CHAT_ENGINES,
  filterDrawerChats,
  filterDrawerChatsByEngines,
  isSubAgentChat,
  searchDrawerChats,
} from '../drawerChats';

function chat(
  id: string,
  partial: Partial<ChatSummary> = {}
): ChatSummary {
  return {
    id,
    title: partial.title ?? id,
    status: partial.status ?? 'idle',
    createdAt: partial.createdAt ?? '2026-03-20T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-03-20T00:00:00.000Z',
    statusUpdatedAt: partial.statusUpdatedAt ?? '2026-03-20T00:00:00.000Z',
    lastMessagePreview: partial.lastMessagePreview ?? '',
    cwd: partial.cwd,
    engine: partial.engine,
    modelProvider: partial.modelProvider,
    sourceKind: partial.sourceKind,
    parentThreadId: partial.parentThreadId,
    subAgentDepth: partial.subAgentDepth,
    lastRunStartedAt: partial.lastRunStartedAt,
    lastRunFinishedAt: partial.lastRunFinishedAt,
    lastRunDurationMs: partial.lastRunDurationMs,
    lastRunExitCode: partial.lastRunExitCode,
    lastRunTimedOut: partial.lastRunTimedOut,
    lastError: partial.lastError,
  };
}

describe('drawerChats', () => {
  it('recognizes sub-agent chats from parent thread or source kind', () => {
    expect(isSubAgentChat(chat('root'))).toBe(false);
    expect(
      isSubAgentChat(
        chat('child-parent', {
          parentThreadId: 'root',
        })
      )
    ).toBe(true);
    expect(
      isSubAgentChat(
        chat('child-source', {
          sourceKind: 'subAgentThreadSpawn',
        })
      )
    ).toBe(true);
  });

  it('filters sub-agent chats out of the top-level drawer list', () => {
    const chats = [
      chat('root', { title: 'Main thread' }),
      chat('worker-1', {
        title: 'Spawned worker',
        sourceKind: 'subAgentThreadSpawn',
        parentThreadId: 'root',
      }),
      chat('worker-2', {
        title: 'Review worker',
        sourceKind: 'subAgentReview',
      }),
    ];

    expect(filterDrawerChats(chats).map((entry) => entry.id)).toEqual(['root']);
  });

  it('filters chats by selected engines and treats missing engine as Codex', () => {
    const chats = [
      chat('codex-explicit', { engine: 'codex' }),
      chat('codex-implicit'),
      chat('opencode', { engine: 'opencode' }),
    ];

    expect(filterDrawerChatsByEngines(chats, DEFAULT_DRAWER_CHAT_ENGINES).map((entry) => entry.id)).toEqual([
      'codex-explicit',
      'codex-implicit',
      'opencode',
    ]);
    expect(filterDrawerChatsByEngines(chats, ['codex']).map((entry) => entry.id)).toEqual([
      'codex-explicit',
      'codex-implicit',
    ]);
    expect(filterDrawerChatsByEngines(chats, ['opencode']).map((entry) => entry.id)).toEqual([
      'opencode',
    ]);
    expect(filterDrawerChatsByEngines(chats, []).map((entry) => entry.id)).toEqual([
      'codex-explicit',
      'codex-implicit',
      'opencode',
    ]);
  });

  it('searches chats by title, preview, and workspace path', () => {
    const chats = [
      chat('title-match', {
        title: 'Verification of Slowness',
      }),
      chat('preview-match', {
        title: 'Bug triage',
        lastMessagePreview: 'Bridge connection feels delayed after send',
      }),
      chat('cwd-match', {
        title: 'Untitled',
        cwd: '/Users/me/projects/clawdex-mobile',
      }),
    ];

    expect(searchDrawerChats(chats, 'slowness').map((entry) => entry.id)).toEqual([
      'title-match',
    ]);
    expect(searchDrawerChats(chats, 'delayed send').map((entry) => entry.id)).toEqual([
      'preview-match',
    ]);
    expect(searchDrawerChats(chats, 'clawdex mobile').map((entry) => entry.id)).toEqual([
      'cwd-match',
    ]);
  });

  it('returns all chats for blank queries', () => {
    const chats = [chat('one'), chat('two')];

    expect(searchDrawerChats(chats, '').map((entry) => entry.id)).toEqual(['one', 'two']);
    expect(searchDrawerChats(chats, '   ').map((entry) => entry.id)).toEqual(['one', 'two']);
  });
});
