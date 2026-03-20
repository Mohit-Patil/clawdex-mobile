import type { ChatSummary } from '../../api/types';
import { buildChatWorkspaceSections } from '../chatThreadTree';

function chat(partial: Partial<ChatSummary> & Pick<ChatSummary, 'id' | 'updatedAt'>): ChatSummary {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'idle',
    createdAt: partial.createdAt ?? '2026-03-19T00:00:00.000Z',
    updatedAt: partial.updatedAt,
    statusUpdatedAt: partial.statusUpdatedAt ?? partial.updatedAt,
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

describe('buildChatWorkspaceSections', () => {
  it('nests sub-agent rows below their root thread', () => {
    const sections = buildChatWorkspaceSections([
      chat({
        id: 'root',
        title: 'Review repo',
        cwd: '/workspace/repo',
        updatedAt: '2026-03-20T10:00:00.000Z',
      }),
      chat({
        id: 'agent-a',
        title: 'Review app',
        cwd: '/workspace/repo/sub',
        updatedAt: '2026-03-20T09:59:00.000Z',
        parentThreadId: 'root',
        sourceKind: 'subAgentThreadSpawn',
        subAgentDepth: 1,
      }),
      chat({
        id: 'agent-b',
        title: 'Review bridge',
        cwd: '/workspace/repo',
        updatedAt: '2026-03-20T09:58:00.000Z',
        parentThreadId: 'root',
        sourceKind: 'subAgentReview',
        subAgentDepth: 1,
      }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('repo');
    expect(sections[0].itemCount).toBe(3);
    expect(sections[0].data.map((row) => [row.chat.id, row.indentLevel])).toEqual([
      ['root', 0],
      ['agent-a', 1],
      ['agent-b', 1],
    ]);
  });

  it('groups sub-agent rows under the root workspace', () => {
    const sections = buildChatWorkspaceSections([
      chat({
        id: 'root',
        title: 'Root',
        cwd: '/workspace/one',
        updatedAt: '2026-03-20T10:00:00.000Z',
      }),
      chat({
        id: 'child',
        title: 'Child',
        cwd: '/workspace/two',
        updatedAt: '2026-03-20T09:59:00.000Z',
        parentThreadId: 'root',
        sourceKind: 'subAgentThreadSpawn',
        subAgentDepth: 1,
      }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('/workspace/one');
    expect(sections[0].data.map((row) => row.chat.id)).toEqual(['root', 'child']);
  });
});
