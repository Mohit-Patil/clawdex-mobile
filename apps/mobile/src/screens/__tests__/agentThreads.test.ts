import type { ChatSummary } from '../../api/types';
import {
  collectLiveAgentPanelThreadIds,
  collectRelatedAgentThreads,
  describeAgentThreadSource,
  findMatchingAgentThread,
} from '../agentThreads';

function chat(
  id: string,
  partial: Partial<ChatSummary> = {}
): ChatSummary {
  return {
    id,
    title: partial.title ?? id,
    status: partial.status ?? 'complete',
    createdAt: partial.createdAt ?? '2026-03-20T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-03-20T00:00:00.000Z',
    statusUpdatedAt: partial.statusUpdatedAt ?? '2026-03-20T00:00:00.000Z',
    lastMessagePreview: partial.lastMessagePreview ?? '',
    cwd: partial.cwd,
    modelProvider: partial.modelProvider,
    agentNickname: partial.agentNickname,
    agentRole: partial.agentRole,
    sourceKind: partial.sourceKind,
    parentThreadId: partial.parentThreadId,
    subAgentDepth: partial.subAgentDepth,
    lastError: partial.lastError,
  };
}

describe('agentThreads', () => {
  it('collects the full related thread tree for a spawned sub-agent', () => {
    const root = chat('thr_root', {
      title: 'Main task',
      sourceKind: 'appServer',
      updatedAt: '2026-03-20T00:00:01.000Z',
    });
    const child = chat('thr_child', {
      title: 'Worker one',
      sourceKind: 'subAgentThreadSpawn',
      parentThreadId: 'thr_root',
      subAgentDepth: 1,
      status: 'running',
      updatedAt: '2026-03-20T00:00:03.000Z',
    });
    const grandchild = chat('thr_grandchild', {
      title: 'Nested worker',
      sourceKind: 'subAgentThreadSpawn',
      parentThreadId: 'thr_child',
      subAgentDepth: 2,
      updatedAt: '2026-03-20T00:00:02.000Z',
    });
    const unrelated = chat('thr_other', {
      title: 'Other thread',
      sourceKind: 'appServer',
      updatedAt: '2026-03-20T00:00:04.000Z',
    });

    const result = collectRelatedAgentThreads(
      [root, child, grandchild, unrelated],
      grandchild
    );

    expect(result.rootThreadId).toBe('thr_root');
    expect(result.threads.map((entry) => entry.id)).toEqual([
      'thr_root',
      'thr_child',
      'thr_grandchild',
    ]);
  });

  it('keeps the full related sub-agent history for the agent selector', () => {
    const root = chat('thr_root', {
      title: 'Main task',
      sourceKind: 'appServer',
      updatedAt: '2026-03-18T00:00:00.000Z',
    });
    const recentChild = chat('thr_recent', {
      title: 'Recent worker',
      sourceKind: 'subAgentThreadSpawn',
      parentThreadId: 'thr_root',
      subAgentDepth: 1,
      updatedAt: '2026-03-20T11:00:00.000Z',
    });
    const oldRunningChild = chat('thr_running', {
      title: 'Running worker',
      sourceKind: 'subAgentThreadSpawn',
      parentThreadId: 'thr_root',
      subAgentDepth: 1,
      status: 'running',
      updatedAt: '2026-03-17T00:00:00.000Z',
    });
    const oldFocusedChild = chat('thr_focused', {
      title: 'Focused worker',
      sourceKind: 'subAgentThreadSpawn',
      parentThreadId: 'thr_root',
      subAgentDepth: 1,
      updatedAt: '2026-03-17T00:00:00.000Z',
    });
    const oldCompletedChild = chat('thr_old', {
      title: 'Old worker',
      sourceKind: 'subAgentThreadSpawn',
      parentThreadId: 'thr_root',
      subAgentDepth: 1,
      updatedAt: '2026-03-16T00:00:00.000Z',
    });

    const result = collectRelatedAgentThreads(
      [root, recentChild, oldRunningChild, oldFocusedChild, oldCompletedChild],
      oldFocusedChild
    );

    expect(result.threads.map((entry) => entry.id)).toEqual([
      'thr_root',
      'thr_running',
      'thr_recent',
      'thr_focused',
      'thr_old',
    ]);
  });

  it('matches agent threads by id, title, or preview text', () => {
    const root = chat('thr_root', { title: 'Main task' });
    const child = chat('thr_child', {
      title: 'Docs worker',
      agentNickname: 'Atlas',
      agentRole: 'explorer',
      lastMessagePreview: 'OpenAI docs search',
    });

    expect(findMatchingAgentThread([root, child], 'thr_child')?.id).toBe('thr_child');
    expect(findMatchingAgentThread([root, child], 'atlas')?.id).toBe('thr_child');
    expect(findMatchingAgentThread([root, child], 'explorer')?.id).toBe('thr_child');
    expect(findMatchingAgentThread([root, child], 'docs worker')?.id).toBe('thr_child');
    expect(findMatchingAgentThread([root, child], 'docs search')?.id).toBe('thr_child');
  });

  it('describes root and sub-agent source kinds for the selector', () => {
    const root = chat('thr_root', { sourceKind: 'appServer' });
    const review = chat('thr_review', {
      sourceKind: 'subAgentReview',
      parentThreadId: 'thr_root',
    });

    expect(describeAgentThreadSource(root, 'thr_root')).toBe('Main thread');
    expect(describeAgentThreadSource(review, 'thr_root')).toBe('Review agent');
  });

  it('includes the main thread in the live agent panel when sub-agents are active', () => {
    expect(
      collectLiveAgentPanelThreadIds([
        { id: 'thr_root', isRootThread: true, isActive: false },
        { id: 'thr_child_1', isRootThread: false, isActive: true },
        { id: 'thr_child_2', isRootThread: false, isActive: true },
        { id: 'thr_child_3', isRootThread: false, isActive: false },
      ])
    ).toEqual(['thr_root', 'thr_child_1', 'thr_child_2']);
  });

  it('keeps the live agent panel hidden when no sub-agent is active', () => {
    expect(
      collectLiveAgentPanelThreadIds([
        { id: 'thr_root', isRootThread: true, isActive: true },
        { id: 'thr_child_1', isRootThread: false, isActive: false },
        { id: 'thr_child_2', isRootThread: false, isActive: false },
      ])
    ).toEqual([]);
  });
});
