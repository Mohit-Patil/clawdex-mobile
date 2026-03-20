import type { ChatSummary } from '../../api/types';
import { filterDrawerChats, isSubAgentChat } from '../drawerChats';

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
});
