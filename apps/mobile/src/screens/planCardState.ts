import type { CollaborationMode, TurnPlanStep } from '../api/types';

export interface PlanCardStateLike {
  explanation: string | null;
  steps: TurnPlanStep[];
}

export type WorkflowCardMode = 'plan' | 'approval' | 'execution';

export interface ResolveWorkflowCardModeArgs {
  collaborationMode: CollaborationMode;
  hasStructuredPlan: boolean;
  hasPlanApprovalPrompt: boolean;
}

export function hasStructuredPlanCardContent(
  plan: PlanCardStateLike | null | undefined
): boolean {
  return Boolean(plan && (plan.steps.length > 0 || plan.explanation?.trim()));
}

export function resolveWorkflowCardMode({
  collaborationMode,
  hasStructuredPlan,
  hasPlanApprovalPrompt,
}: ResolveWorkflowCardModeArgs): WorkflowCardMode | null {
  if (hasPlanApprovalPrompt) {
    return 'approval';
  }

  if (hasStructuredPlan && collaborationMode === 'default') {
    return 'execution';
  }

  if (hasStructuredPlan) {
    return 'plan';
  }

  return null;
}
