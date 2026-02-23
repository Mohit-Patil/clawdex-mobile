export type ChatStatus = 'idle' | 'running' | 'error' | 'complete';

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  lastMessagePreview: string;
  cwd?: string;
  modelProvider?: string;
  sourceKind?: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  lastRunDurationMs?: number;
  lastRunExitCode?: number | null;
  lastRunTimedOut?: boolean;
  lastError?: string;
}

export interface Chat extends ChatSummary {
  messages: ChatMessage[];
}

export interface CreateChatRequest {
  title?: string;
  message?: string;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
}

export type CollaborationMode = 'default' | 'plan';

export interface SendChatMessageRequest {
  content: string;
  role?: ChatMessageRole;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
  collaborationMode?: CollaborationMode;
  mentions?: MentionInput[];
  localImages?: LocalImageInput[];
}

export interface MentionInput {
  path: string;
  name?: string;
}

export interface LocalImageInput {
  path: string;
}

export type AttachmentUploadKind = 'file' | 'image';

export interface UploadAttachmentRequest {
  dataBase64: string;
  fileName?: string;
  mimeType?: string;
  threadId?: string;
  kind?: AttachmentUploadKind;
}

export interface UploadAttachmentResponse {
  path: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  kind: AttachmentUploadKind;
}

export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type ApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'on-failure'
  | 'never';

export type ApprovalMode = 'normal' | 'yolo';

export interface ModelReasoningEffortOption {
  effort: ReasoningEffort;
  description?: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  supportsPersonality?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEffort?: ModelReasoningEffortOption[];
}

export interface TerminalExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface TerminalExecResponse {
  command: string;
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface GitStatusResponse {
  branch: string;
  clean: boolean;
  raw: string;
  files: GitStatusFile[];
  cwd?: string;
}

export interface GitStatusFile {
  path: string;
  originalPath?: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitDiffResponse {
  diff: string;
  cwd?: string;
}

export interface GitFileRequest {
  path: string;
  cwd?: string;
}

export interface GitStageResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  staged: boolean;
  path: string;
  cwd?: string;
}

export interface GitStageAllResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  staged: boolean;
  cwd?: string;
}

export interface GitUnstageResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  unstaged: boolean;
  path: string;
  cwd?: string;
}

export interface GitUnstageAllResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  unstaged: boolean;
  cwd?: string;
}

export interface GitCommitRequest {
  message: string;
  cwd?: string;
}

export interface GitCommitResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  committed: boolean;
  cwd?: string;
}

export interface GitPushResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  pushed: boolean;
  cwd?: string;
}

export type ApprovalKind = 'commandExecution' | 'fileChange';

export interface ApprovalExecpolicyAmendmentDecision {
  acceptWithExecpolicyAmendment: {
    execpolicy_amendment: string[];
  };
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | ApprovalExecpolicyAmendmentDecision;

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  requestedAt: string;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  proposedExecpolicyAmendment?: string[];
}

export interface ResolveApprovalRequest {
  decision: ApprovalDecision;
}

export interface ResolveApprovalResponse {
  ok: true;
  approval: PendingApproval;
  decision: ApprovalDecision;
}

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputQuestionOption[] | null;
}

export interface PendingUserInputRequest {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  requestedAt: string;
  questions: UserInputQuestion[];
}

export interface UserInputAnswerPayload {
  answers: string[];
}

export interface ResolveUserInputRequest {
  answers: Record<string, UserInputAnswerPayload>;
}

export interface ResolveUserInputResponse {
  ok: true;
  request: PendingUserInputRequest;
}

export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

export interface TurnPlanUpdate {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
}

export interface RunEvent {
  id: string;
  threadId: string;
  eventType: string;
  at: string;
  detail?: string;
}

export interface RpcNotification {
  method: string;
  params: Record<string, unknown> | null;
  eventId?: number;
}
