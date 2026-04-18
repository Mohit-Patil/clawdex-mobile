export interface ComputerUseTraceSourceEntry {
  id: string;
  title: string;
  details: string[];
}

export interface ParsedComputerUseTraceEntry {
  actionKey: string;
  actionLabel: string;
  appName: string | null;
  windowTitle: string | null;
}

const COMPUTER_USE_SERVER_KEYS = new Set(['computeruse']);

export function isComputerUseTraceEntry(entry: Pick<ComputerUseTraceSourceEntry, 'title'>): boolean {
  return parseComputerUseToolLabel(entry.title) !== null;
}

export function parseComputerUseTraceEntry(
  entry: Pick<ComputerUseTraceSourceEntry, 'title' | 'details'>
): ParsedComputerUseTraceEntry | null {
  const toolLabel = parseComputerUseToolLabel(entry.title);
  if (!toolLabel) {
    return null;
  }

  let appName: string | null = null;
  let windowTitle: string | null = null;

  for (const rawDetail of entry.details) {
    const detail = rawDetail.trimEnd();
    if (!detail.trim()) {
      continue;
    }

    const windowMetadata = parseComputerUseWindowMetadata(detail);
    if (windowMetadata) {
      appName = windowMetadata.appName ?? appName;
      windowTitle = windowTitle ?? windowMetadata.windowTitle;
      continue;
    }

    const appMetadata = parseComputerUseAppMetadata(detail);
    if (appMetadata) {
      appName = appName ?? appMetadata;
      continue;
    }
  }

  return {
    actionKey: toolLabel.actionKey,
    actionLabel: computerUseActionLabel(toolLabel.actionKey, toolLabel.rawActionName),
    appName,
    windowTitle,
  };
}

export function computerUseActionIconName(actionKey: string):
  | 'scan-outline'
  | 'radio-button-on-outline'
  | 'swap-vertical-outline'
  | 'text-outline'
  | 'keypad-outline'
  | 'move-outline'
  | 'create-outline'
  | 'list-outline'
  | 'desktop-outline' {
  switch (actionKey) {
    case 'getappstate':
      return 'scan-outline';
    case 'click':
      return 'radio-button-on-outline';
    case 'scroll':
      return 'swap-vertical-outline';
    case 'typetext':
      return 'text-outline';
    case 'presskey':
      return 'keypad-outline';
    case 'drag':
      return 'move-outline';
    case 'setvalue':
      return 'create-outline';
    case 'listapps':
      return 'list-outline';
    default:
      return 'desktop-outline';
  }
}

function parseComputerUseToolLabel(
  title: string
): { actionKey: string; rawActionName: string } | null {
  const labelMatch = title.match(/`([^`]+)`/);
  const label = labelMatch?.[1]?.trim();
  if (!label) {
    return null;
  }

  const [serverLabel, ...toolSegments] = label.split('/').map((segment) => segment.trim());
  const normalizedServer = normalizeComputerUseToken(serverLabel);
  if (!normalizedServer || !COMPUTER_USE_SERVER_KEYS.has(normalizedServer)) {
    return null;
  }

  const toolName = toolSegments.join(' / ').trim();
  if (!toolName) {
    return null;
  }

  return {
    actionKey: normalizeComputerUseToken(toolName),
    rawActionName: toolName,
  };
}

function parseComputerUseWindowMetadata(
  detail: string
): { appName: string | null; windowTitle: string | null } | null {
  const match = detail.match(/^Window:\s*(.+?)(?:,\s*App:\s*([^,]+?))?\.?$/i);
  if (!match) {
    return null;
  }

  const rawWindowTitle = match[1]?.trim() ?? '';
  const windowTitle = stripWrappedQuotes(rawWindowTitle) || null;
  const appName = normalizeComputerUseAppName(match[2] ?? null);

  return {
    appName,
    windowTitle,
  };
}

function parseComputerUseAppMetadata(detail: string): string | null {
  const appMatch = detail.match(/\bApp=([^\s(]+)(?:\s*\(|$)/);
  if (!appMatch?.[1]) {
    return null;
  }

  return normalizeComputerUseAppName(appMatch[1]);
}

function normalizeComputerUseAppName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('.')) {
    const segment = trimmed.split('.').filter(Boolean).pop() ?? trimmed;
    return humanizeToken(segment);
  }

  return stripWrappedQuotes(trimmed) || trimmed;
}

function computerUseActionLabel(actionKey: string, rawActionName: string): string {
  switch (actionKey) {
    case 'getappstate':
      return 'Captured screen';
    case 'click':
      return 'Clicked';
    case 'scroll':
      return 'Scrolled';
    case 'typetext':
      return 'Typed text';
    case 'presskey':
      return 'Pressed key';
    case 'drag':
      return 'Dragged';
    case 'setvalue':
      return 'Set value';
    case 'listapps':
      return 'Listed apps';
    default:
      return humanizeToken(rawActionName);
  }
}

function stripWrappedQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^["']+|["']+$/g, '').trim();
}

function humanizeToken(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return 'Computer Use';
  }

  return normalized
    .split(' ')
    .map((segment) =>
      segment.length > 0 ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment
    )
    .join(' ');
}

function normalizeComputerUseToken(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/[^\w]/g, '');
}
