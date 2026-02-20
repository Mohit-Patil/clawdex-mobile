import type {
  GitCommitResponse,
  GitDiffResponse,
  GitStatusResponse
} from '../types';
import type { TerminalService } from './terminalService';

export class GitService {
  constructor(
    private readonly terminal: TerminalService,
    private readonly repoPath: string
  ) {}

  async getStatus(): Promise<GitStatusResponse> {
    const result = await this.runGit(['status', '--short', '--branch']);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || 'git status failed');
    }

    const lines = result.stdout.split('\n').filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith('## '));
    const branch = branchLine
      ? branchLine.replace(/^##\s*/, '').split('...')[0]
      : 'unknown';
    const clean = lines.filter((line) => !line.startsWith('## ')).length === 0;

    return {
      branch,
      clean,
      raw: result.stdout
    };
  }

  async getDiff(): Promise<GitDiffResponse> {
    const result = await this.runGit(['diff']);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || 'git diff failed');
    }

    return {
      diff: result.stdout
    };
  }

  async commit(message: string): Promise<GitCommitResponse> {
    const result = await this.runGit(['commit', '-m', message]);

    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      committed: result.code === 0
    };
  }

  private runGit(args: string[]) {
    return this.terminal.executeBinary('git', ['-C', this.repoPath, ...args], {
      cwd: this.repoPath
    });
  }
}
