import type { ChatSummary } from '../api/types';

export interface DrawerThreadRow {
  chat: ChatSummary;
  indentLevel: number;
  rootThreadId: string;
}

export interface ChatWorkspaceSection {
  key: string;
  title: string;
  subtitle?: string;
  itemCount: number;
  data: DrawerThreadRow[];
}

const DEFAULT_WORKSPACE_KEY = '__bridge_default_workspace__';

export function buildChatWorkspaceSections(chats: ChatSummary[]): ChatWorkspaceSection[] {
  if (chats.length === 0) {
    return [];
  }

  const chatMap = new Map<string, ChatSummary>();
  for (const chat of chats) {
    chatMap.set(chat.id, chat);
  }

  const childrenByParentId = new Map<string, ChatSummary[]>();
  const roots: ChatSummary[] = [];

  for (const chat of chats) {
    const parentThreadId = normalizeThreadId(chat.parentThreadId);
    if (!parentThreadId || !chatMap.has(parentThreadId) || parentThreadId === chat.id) {
      roots.push(chat);
      continue;
    }

    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings) {
      siblings.push(chat);
    } else {
      childrenByParentId.set(parentThreadId, [chat]);
    }
  }

  const rootsByWorkspace = new Map<
    string,
    {
      cwd: string | null;
      roots: ChatSummary[];
      latestUpdatedAt: string;
    }
  >();

  for (const root of roots.sort(compareByUpdatedAtDesc)) {
    const rootCwd = normalizeCwd(root.cwd);
    const key = workspaceKey(rootCwd);
    const existing = rootsByWorkspace.get(key);

    if (existing) {
      existing.roots.push(root);
      if (root.updatedAt.localeCompare(existing.latestUpdatedAt) > 0) {
        existing.latestUpdatedAt = root.updatedAt;
      }
      continue;
    }

    rootsByWorkspace.set(key, {
      cwd: rootCwd,
      roots: [root],
      latestUpdatedAt: root.updatedAt,
    });
  }

  return Array.from(rootsByWorkspace.entries())
    .sort(([, left], [, right]) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt))
    .map(([key, bucket]) => {
      const data: DrawerThreadRow[] = [];
      for (const root of bucket.roots.sort(compareByUpdatedAtDesc)) {
        appendChatBranch(data, root, 0, root.id, childrenByParentId);
      }

      return {
        key,
        title: workspaceTitle(bucket.cwd),
        subtitle: workspaceSubtitle(bucket.cwd),
        itemCount: data.length,
        data,
      };
    });
}

function appendChatBranch(
  rows: DrawerThreadRow[],
  chat: ChatSummary,
  indentLevel: number,
  rootThreadId: string,
  childrenByParentId: Map<string, ChatSummary[]>
): void {
  rows.push({
    chat,
    indentLevel,
    rootThreadId,
  });

  const children = [...(childrenByParentId.get(chat.id) ?? [])].sort(compareBranchChildren);
  for (const child of children) {
    appendChatBranch(rows, child, indentLevel + 1, rootThreadId, childrenByParentId);
  }
}

function compareBranchChildren(left: ChatSummary, right: ChatSummary): number {
  if (left.status === 'running' && right.status !== 'running') {
    return -1;
  }
  if (right.status === 'running' && left.status !== 'running') {
    return 1;
  }

  const depthDiff = (left.subAgentDepth ?? 0) - (right.subAgentDepth ?? 0);
  if (depthDiff !== 0) {
    return depthDiff;
  }

  const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return left.title.localeCompare(right.title);
}

function compareByUpdatedAtDesc(left: ChatSummary, right: ChatSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function normalizeThreadId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCwd(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function workspaceKey(cwd: string | null): string {
  return cwd ?? DEFAULT_WORKSPACE_KEY;
}

function workspaceTitle(cwd: string | null): string {
  if (!cwd) {
    return 'Bridge default workspace';
  }

  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) {
    return cwd;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return normalized;
  }

  return normalized.slice(lastSlash + 1) || normalized;
}

function workspaceSubtitle(cwd: string | null): string | undefined {
  if (!cwd) {
    return undefined;
  }

  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length <= 2) {
    return normalized;
  }

  return `.../${segments.slice(-2).join('/')}`;
}
