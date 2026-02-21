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
}

export interface SendChatMessageRequest {
  content: string;
  role?: ChatMessageRole;
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
}

export interface GitDiffResponse {
  diff: string;
}

export interface GitCommitRequest {
  message: string;
}

export interface GitCommitResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  committed: boolean;
}

export type ApprovalKind = 'commandExecution' | 'fileChange';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

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
}

export interface ResolveApprovalRequest {
  decision: ApprovalDecision;
}

export interface ResolveApprovalResponse {
  ok: true;
  approval: PendingApproval;
  decision: ApprovalDecision;
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
}
