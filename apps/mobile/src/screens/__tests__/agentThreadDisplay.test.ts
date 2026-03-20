import type { ChatSummary } from '../../api/types';
import {
  buildAgentThreadDisplayState,
  getAgentThreadAccentColor,
} from '../agentThreadDisplay';

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
    lastError: partial.lastError,
  };
}

describe('agentThreadDisplay', () => {
  it('uses live runtime activity for running child threads', () => {
    const display = buildAgentThreadDisplayState(
      chat('thr_worker', { status: 'idle' }),
      {
        activity: {
          tone: 'running',
          title: 'Reasoning',
          detail: 'Inspecting files',
        },
        runWatchdogUntil: Date.parse('2026-03-20T10:00:30.000Z'),
      },
      Date.parse('2026-03-20T10:00:00.000Z')
    );

    expect(display.label).toBe('Reasoning');
    expect(display.detail).toBe('Inspecting files');
    expect(display.tone).toBe('running');
  });

  it('shows pending approvals as active waiting state', () => {
    const display = buildAgentThreadDisplayState(chat('thr_worker'), {
      pendingApproval: { id: 'appr-1' },
      activity: {
        tone: 'running',
        title: 'Working',
      },
    });

    expect(display.label).toBe('Needs approval');
    expect(display.tone).toBe('running');
  });

  it('falls back to error details from the chat summary', () => {
    const display = buildAgentThreadDisplayState(
      chat('thr_worker', {
        status: 'error',
        lastError: 'Command exited 1',
      }),
      null
    );

    expect(display.label).toBe('Error');
    expect(display.detail).toBe('Command exited 1');
    expect(display.tone).toBe('error');
  });

  it('assigns stable accent colors per thread id', () => {
    expect(getAgentThreadAccentColor('thr_worker')).toBe(
      getAgentThreadAccentColor('thr_worker')
    );
  });
});
