import type { TerminalExecResponse } from '../../types';
import { GitService } from '../gitService';
import type { TerminalService } from '../terminalService';

function createMockTerminal(response: Partial<TerminalExecResponse> = {}) {
  const defaults: TerminalExecResponse = {
    command: '',
    cwd: '/repo',
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 10,
    ...response,
  };
  return {
    executeBinary: vi.fn().mockResolvedValue(defaults),
    executeShell: vi.fn(),
  } as unknown as TerminalService;
}

describe('GitService', () => {
  const repoPath = '/repo';

  describe('getStatus', () => {
    it('parses branch from ## main...origin/main', async () => {
      const terminal = createMockTerminal({
        stdout: '## main...origin/main',
      });
      const git = new GitService(terminal, repoPath);

      const status = await git.getStatus();

      expect(status.branch).toBe('main');
    });

    it('parses branch without tracking info: ## feature-x', async () => {
      const terminal = createMockTerminal({
        stdout: '## feature-x',
      });
      const git = new GitService(terminal, repoPath);

      const status = await git.getStatus();

      expect(status.branch).toBe('feature-x');
    });

    it('reports clean: true when only branch line present', async () => {
      const terminal = createMockTerminal({
        stdout: '## main...origin/main',
      });
      const git = new GitService(terminal, repoPath);

      const status = await git.getStatus();

      expect(status.clean).toBe(true);
    });

    it('reports clean: false when modified files are present', async () => {
      const terminal = createMockTerminal({
        stdout: '## main\n M src/index.ts',
      });
      const git = new GitService(terminal, repoPath);

      const status = await git.getStatus();

      expect(status.clean).toBe(false);
    });

    it('throws when exit code is non-zero', async () => {
      const terminal = createMockTerminal({
        code: 128,
        stderr: 'fatal: not a git repository',
      });
      const git = new GitService(terminal, repoPath);

      await expect(git.getStatus()).rejects.toThrow(
        'fatal: not a git repository'
      );
    });

    it('returns raw field with full stdout', async () => {
      const stdout = '## main...origin/main\n M src/index.ts';
      const terminal = createMockTerminal({ stdout });
      const git = new GitService(terminal, repoPath);

      const status = await git.getStatus();

      expect(status.raw).toBe(stdout);
    });
  });

  describe('getDiff', () => {
    it('returns diff from stdout', async () => {
      const diff = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts';
      const terminal = createMockTerminal({ stdout: diff });
      const git = new GitService(terminal, repoPath);

      const result = await git.getDiff();

      expect(result.diff).toBe(diff);
    });

    it('throws when exit code is non-zero', async () => {
      const terminal = createMockTerminal({
        code: 1,
        stderr: 'error: could not read diff',
      });
      const git = new GitService(terminal, repoPath);

      await expect(git.getDiff()).rejects.toThrow(
        'error: could not read diff'
      );
    });
  });

  describe('commit', () => {
    it('returns committed: true when code is 0', async () => {
      const terminal = createMockTerminal({
        code: 0,
        stdout: '[main abc1234] my commit message',
      });
      const git = new GitService(terminal, repoPath);

      const result = await git.commit('my commit message');

      expect(result.committed).toBe(true);
      expect(result.code).toBe(0);
    });

    it('returns committed: false when code is non-zero', async () => {
      const terminal = createMockTerminal({
        code: 1,
        stderr: 'nothing to commit',
      });
      const git = new GitService(terminal, repoPath);

      const result = await git.commit('my commit message');

      expect(result.committed).toBe(false);
      expect(result.code).toBe(1);
    });

    it('passes message as git commit argument', async () => {
      const terminal = createMockTerminal({ code: 0 });
      const git = new GitService(terminal, repoPath);

      await git.commit('fix: resolve bug');

      expect(terminal.executeBinary).toHaveBeenCalledWith(
        'git',
        ['-C', repoPath, 'commit', '-m', 'fix: resolve bug'],
        { cwd: repoPath }
      );
    });
  });
});
