import {
  hasStructuredPlanCardContent,
  resolveWorkflowCardMode,
} from '../planCardState';

describe('planCardState', () => {
  it('hides the plan card when only raw delta text exists', () => {
    expect(
      hasStructuredPlanCardContent({
        explanation: null,
        steps: [],
      })
    ).toBe(false);
  });

  it('shows the plan card when an explanation exists', () => {
    expect(
      hasStructuredPlanCardContent({
        explanation: 'Tighten the release flow before implementation.',
        steps: [],
      })
    ).toBe(true);
  });

  it('shows the plan card when structured steps exist', () => {
    expect(
      hasStructuredPlanCardContent({
        explanation: null,
        steps: [
          {
            step: 'Audit the current dependency set',
            status: 'pending',
          },
        ],
      })
    ).toBe(true);
  });

  it('prefers approval mode when plan approval is pending', () => {
    expect(
      resolveWorkflowCardMode({
        collaborationMode: 'plan',
        hasStructuredPlan: true,
        hasPlanApprovalPrompt: true,
      })
    ).toBe('approval');
  });

  it('uses execution mode after leaving plan mode with a structured plan', () => {
    expect(
      resolveWorkflowCardMode({
        collaborationMode: 'default',
        hasStructuredPlan: true,
        hasPlanApprovalPrompt: false,
      })
    ).toBe('execution');
  });

  it('hides the top workflow card when only queued execution exists', () => {
    expect(
      resolveWorkflowCardMode({
        collaborationMode: 'plan',
        hasStructuredPlan: false,
        hasPlanApprovalPrompt: false,
      })
    ).toBeNull();
  });

  it('uses execution mode when queued execution exists alongside a structured plan', () => {
    expect(
      resolveWorkflowCardMode({
        collaborationMode: 'default',
        hasStructuredPlan: true,
        hasPlanApprovalPrompt: false,
      })
    ).toBe('execution');
  });

  it('uses plan mode for structured plans before implementation', () => {
    expect(
      resolveWorkflowCardMode({
        collaborationMode: 'plan',
        hasStructuredPlan: true,
        hasPlanApprovalPrompt: false,
      })
    ).toBe('plan');
  });
});
