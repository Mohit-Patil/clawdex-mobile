import {
  buildOptimisticGoalBridgeUiSurface,
  extractCodexFailureMessage,
  formatGitCloneFailureMessage,
  parseChatBridgeUiSurfaces,
  parseGoalSlashObjective,
  toBridgeUiSurface,
} from '../mainScreenHelpers';

describe('mainScreenHelpers', () => {
  it('keeps successful git clone responses quiet', () => {
    expect(
      formatGitCloneFailureMessage({
        code: 0,
        stdout: '',
        stderr: '',
        cloned: true,
      })
    ).toBeNull();
  });

  it('surfaces git stderr when clone exits unsuccessfully', () => {
    expect(
      formatGitCloneFailureMessage({
        code: 128,
        stdout: '',
        stderr: 'fatal: repository not found',
        cloned: false,
      })
    ).toBe('fatal: repository not found');
  });

  it('falls back to a readable clone failure when git gives no output', () => {
    expect(
      formatGitCloneFailureMessage(
        {
          code: 1,
          stdout: '',
          stderr: '',
          cloned: false,
        },
        'Mohit-Patil/launchkit'
      )
    ).toBe('Git clone failed for Mohit-Patil/launchkit.');
  });

  it('extracts nested Codex failure details from live event payloads', () => {
    expect(
      extractCodexFailureMessage({
        msg: {
          status: {
            error: {
              details: {
                stderr: 'model quota exceeded',
              },
            },
          },
        },
      })
    ).toBe('model quota exceeded');
  });

  it('parses bridge UI surfaces for provider-owned workflow cards', () => {
    expect(
      toBridgeUiSurface({
        id: 'goal-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'goal',
        presentation: 'workflowCard',
        tone: 'info',
        title: 'Goal',
        subtitle: 'Active',
        bodyMarkdown: 'Ship the generic surface.',
        blocks: [
          {
            type: 'keyValue',
            items: [{ label: 'Status', value: 'active' }],
          },
          {
            type: 'progress',
            label: 'Budget used',
            value: 5,
            max: 10,
          },
        ],
        actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
      })
    ).toMatchObject({
      id: 'goal-1',
      threadId: 'thread-1',
      kind: 'goal',
      presentation: 'workflowCard',
      title: 'Goal',
      blocks: [
        {
          type: 'keyValue',
          items: [{ label: 'Status', value: 'active' }],
        },
        {
          type: 'progress',
          label: 'Budget used',
          value: 5,
          max: 10,
        },
      ],
      actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
    });
  });

  it('hydrates persisted bridge UI surfaces by thread', () => {
    const result = parseChatBridgeUiSurfaces(
      JSON.stringify({
        version: 1,
        entries: {
          'thread-1': [
            {
              id: 'goal-1',
              threadId: 'thread-1',
              presentation: 'workflowCard',
              title: 'Goal',
              subtitle: 'Active',
              blocks: [
                {
                  type: 'keyValue',
                  items: [{ label: 'Status', value: 'Active' }],
                },
              ],
              actions: [{ id: 'dismiss', label: 'Dismiss' }],
            },
          ],
          'thread-2': [
            {
              id: 'wrong-thread',
              threadId: 'thread-1',
              presentation: 'workflowCard',
              title: 'Goal',
            },
          ],
        },
      })
    );

    expect(result).toMatchObject({
      'thread-1': [
        {
          id: 'goal-1',
          threadId: 'thread-1',
          presentation: 'workflowCard',
          title: 'Goal',
        },
      ],
    });
    expect(result['thread-2']).toBeUndefined();
  });

  it('builds an optimistic replacement surface for new goal slash commands', () => {
    expect(parseGoalSlashObjective('/goal Now verify the PR')).toBe('Now verify the PR');
    expect(parseGoalSlashObjective('/goal')).toBeNull();
    expect(parseGoalSlashObjective('/model gpt-5.5')).toBeNull();

    expect(
      buildOptimisticGoalBridgeUiSurface(
        'codex:thread-1',
        'Now verify the PR',
        '2026-05-17T03:00:00.000Z'
      )
    ).toMatchObject({
      id: 'goal-codex:thread-1',
      threadId: 'codex:thread-1',
      kind: 'goal',
      presentation: 'workflowCard',
      subtitle: 'Starting',
      bodyMarkdown: 'Now verify the PR',
      blocks: [
        {
          type: 'keyValue',
          items: [{ label: 'Status', value: 'Starting' }],
        },
      ],
    });
  });
});
