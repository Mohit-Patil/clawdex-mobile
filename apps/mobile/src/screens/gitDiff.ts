export type UnifiedDiffLineKind = 'context' | 'add' | 'remove' | 'meta';

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  prefix: string;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface UnifiedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffLine[];
}

export type UnifiedDiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

export interface UnifiedDiffFile {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  status: UnifiedDiffFileStatus;
  additions: number;
  deletions: number;
  hunks: UnifiedDiffHunk[];
}

export interface UnifiedDiffDocument {
  files: UnifiedDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

interface InProgressFile {
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  status: UnifiedDiffFileStatus;
  additions: number;
  deletions: number;
  hunks: UnifiedDiffHunk[];
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s(.*))?$/;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;

export function parseUnifiedGitDiff(rawDiff: string): UnifiedDiffDocument {
  const normalizedDiff = rawDiff.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedDiff.split('\n');

  const files: UnifiedDiffFile[] = [];
  let currentFile: InProgressFile | null = null;
  let currentHunk: UnifiedDiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  const flushHunk = () => {
    if (!currentFile || !currentHunk) {
      return;
    }

    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  const flushFile = () => {
    if (!currentFile) {
      return;
    }

    flushHunk();
    files.push(finalizeFile(currentFile, files.length));
    currentFile = null;
  };

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);

    if (line.startsWith('diff --git ')) {
      flushFile();
      const paths = parseDiffHeaderPaths(line);
      currentFile = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        displayPath: formatDisplayPath(paths.oldPath, paths.newPath),
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('@@ ')) {
      flushHunk();
      const parsedHeader = parseHunkHeader(line);
      if (!parsedHeader) {
        continue;
      }

      oldCursor = parsedHeader.oldStart;
      newCursor = parsedHeader.newStart;
      currentHunk = {
        header: line,
        oldStart: parsedHeader.oldStart,
        oldCount: parsedHeader.oldCount,
        newStart: parsedHeader.newStart,
        newCount: parsedHeader.newCount,
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) {
        currentHunk.lines.push({
          kind: 'add',
          prefix: '+',
          content: line.slice(1),
          oldLineNumber: null,
          newLineNumber: newCursor,
        });
        currentFile.additions += 1;
        newCursor += 1;
        continue;
      }

      if (line.startsWith('-') && !line.startsWith('--- ')) {
        currentHunk.lines.push({
          kind: 'remove',
          prefix: '-',
          content: line.slice(1),
          oldLineNumber: oldCursor,
          newLineNumber: null,
        });
        currentFile.deletions += 1;
        oldCursor += 1;
        continue;
      }

      if (line.startsWith(' ')) {
        currentHunk.lines.push({
          kind: 'context',
          prefix: ' ',
          content: line.slice(1),
          oldLineNumber: oldCursor,
          newLineNumber: newCursor,
        });
        oldCursor += 1;
        newCursor += 1;
        continue;
      }

      if (line.startsWith('\\')) {
        currentHunk.lines.push({
          kind: 'meta',
          prefix: '\\',
          content: line.slice(1).trimStart(),
          oldLineNumber: null,
          newLineNumber: null,
        });
        continue;
      }

      currentHunk.lines.push({
        kind: 'meta',
        prefix: ' ',
        content: line,
        oldLineNumber: null,
        newLineNumber: null,
      });
      continue;
    }

    applyFileMetadata(line, currentFile);
  }

  flushFile();

  return {
    files,
    totalAdditions: files.reduce((total, file) => total + file.additions, 0),
    totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

function parseHunkHeader(
  line: string
): Pick<UnifiedDiffHunk, 'oldStart' | 'oldCount' | 'newStart' | 'newCount'> | null {
  const match = line.match(HUNK_HEADER_PATTERN);
  if (!match) {
    return null;
  }

  const oldStart = Number.parseInt(match[1], 10);
  const oldCount = Number.parseInt(match[2] ?? '1', 10);
  const newStart = Number.parseInt(match[3], 10);
  const newCount = Number.parseInt(match[4] ?? '1', 10);

  if (
    Number.isNaN(oldStart) ||
    Number.isNaN(oldCount) ||
    Number.isNaN(newStart) ||
    Number.isNaN(newCount)
  ) {
    return null;
  }

  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
  };
}

function parseDiffHeaderPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const payload = line.slice('diff --git '.length).trim();
  const [leftRaw, rightRaw] = splitDiffHeaderPayload(payload);
  return {
    oldPath: parsePatchPath(leftRaw),
    newPath: parsePatchPath(rightRaw),
  };
}

function splitDiffHeaderPayload(payload: string): [string, string] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;

  for (const char of payload) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes && char === ' ') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return [tokens[0] ?? '', tokens[1] ?? ''];
}

function applyFileMetadata(line: string, file: InProgressFile): void {
  if (line.startsWith('new file mode ')) {
    file.status = 'added';
  } else if (line.startsWith('deleted file mode ')) {
    file.status = 'deleted';
  } else if (line.startsWith('rename from ')) {
    file.status = 'renamed';
    file.oldPath = decodeGitPath(line.slice('rename from '.length));
  } else if (line.startsWith('rename to ')) {
    file.status = 'renamed';
    file.newPath = decodeGitPath(line.slice('rename to '.length));
  } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    file.status = 'binary';
  } else if (line.startsWith('--- ')) {
    file.oldPath = parsePatchPath(line.slice(4));
  } else if (line.startsWith('+++ ')) {
    file.newPath = parsePatchPath(line.slice(4));
  }

  file.displayPath = formatDisplayPath(file.oldPath, file.newPath);
}

function parsePatchPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/dev/null') {
    return null;
  }

  const decoded = decodeGitPath(trimmed);
  if (decoded === '/dev/null') {
    return null;
  }

  if (decoded.startsWith('a/') || decoded.startsWith('b/')) {
    return decoded.slice(2);
  }

  return decoded;
}

function decodeGitPath(rawPath: string): string {
  if (!rawPath.startsWith('"') || !rawPath.endsWith('"') || rawPath.length < 2) {
    return rawPath;
  }

  const inner = rawPath.slice(1, -1);
  return inner
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');
}

function formatDisplayPath(oldPath: string | null, newPath: string | null): string {
  if (oldPath && newPath) {
    if (oldPath === newPath) {
      return newPath;
    }
    return `${oldPath} -> ${newPath}`;
  }

  if (newPath) {
    return newPath;
  }

  if (oldPath) {
    return oldPath;
  }

  return 'unknown';
}

function finalizeFile(file: InProgressFile, index: number): UnifiedDiffFile {
  let status = file.status;

  if (status === 'modified') {
    if (!file.oldPath && file.newPath) {
      status = 'added';
    } else if (file.oldPath && !file.newPath) {
      status = 'deleted';
    } else if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
      status = 'renamed';
    }
  }

  const displayPath = formatDisplayPath(file.oldPath, file.newPath);

  return {
    id: `${displayPath}:${index}`,
    oldPath: file.oldPath,
    newPath: file.newPath,
    displayPath,
    status,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks,
  };
}
