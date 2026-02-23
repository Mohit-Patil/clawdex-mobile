import { parseUnifiedGitDiff } from '../gitDiff';

describe('parseUnifiedGitDiff', () => {
  it('parses a modified file with numbered unified diff lines', () => {
    const input = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1234..5678 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 changed',
      '+line3',
      ' line4',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.totalAdditions).toBe(2);
    expect(parsed.totalDeletions).toBe(1);

    const file = parsed.files[0];
    expect(file.displayPath).toBe('src/app.ts');
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]).toMatchObject({
      kind: 'context',
      oldLineNumber: 1,
      newLineNumber: 1,
      content: 'line1',
    });
    expect(hunk.lines[1]).toMatchObject({
      kind: 'remove',
      oldLineNumber: 2,
      newLineNumber: null,
      content: 'line2',
    });
    expect(hunk.lines[2]).toMatchObject({
      kind: 'add',
      oldLineNumber: null,
      newLineNumber: 2,
      content: 'line2 changed',
    });
    expect(hunk.lines[4]).toMatchObject({
      kind: 'context',
      oldLineNumber: 3,
      newLineNumber: 4,
      content: 'line4',
    });
  });

  it('marks /dev/null sources as added files', () => {
    const input = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..beef123',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+const value = 1;',
      '+export default value;',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      status: 'added',
      oldPath: null,
      newPath: 'src/new.ts',
      additions: 2,
      deletions: 0,
    });
  });

  it('handles renamed files with quoted paths', () => {
    const input = [
      'diff --git "a/src/old name.ts" "b/src/new name.ts"',
      'similarity index 100%',
      'rename from src/old name.ts',
      'rename to src/new name.ts',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      status: 'renamed',
      oldPath: 'src/old name.ts',
      newPath: 'src/new name.ts',
      displayPath: 'src/old name.ts -> src/new name.ts',
      additions: 0,
      deletions: 0,
    });
  });

  it('ignores ANSI color escapes in diff output', () => {
    const input = [
      '\u001b[1mdiff --git a/src/color.ts b/src/color.ts\u001b[0m',
      '--- a/src/color.ts',
      '+++ b/src/color.ts',
      '@@ -1 +1 @@',
      '\u001b[31m-oldValue\u001b[0m',
      '\u001b[32m+newValue\u001b[0m',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      displayPath: 'src/color.ts',
      additions: 1,
      deletions: 1,
    });
    expect(parsed.files[0].hunks[0].lines[0]).toMatchObject({
      kind: 'remove',
      content: 'oldValue',
    });
    expect(parsed.files[0].hunks[0].lines[1]).toMatchObject({
      kind: 'add',
      content: 'newValue',
    });
  });
});
