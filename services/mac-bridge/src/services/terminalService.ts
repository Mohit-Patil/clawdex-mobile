import { spawn } from 'node:child_process';

import type { TerminalExecResponse } from '../types';

interface ExecuteOptions {
  cwd: string;
  timeoutMs?: number;
}

export class TerminalService {
  async executeShell(
    command: string,
    options: ExecuteOptions
  ): Promise<TerminalExecResponse> {
    return this.run('bash', ['-lc', command], command, options);
  }

  async executeBinary(
    binary: string,
    args: string[],
    options: ExecuteOptions
  ): Promise<TerminalExecResponse> {
    const displayCommand = [binary, ...args].join(' ');
    return this.run(binary, args, displayCommand, options);
  }

  private run(
    binary: string,
    args: string[],
    displayCommand: string,
    options: ExecuteOptions
  ): Promise<TerminalExecResponse> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const child = spawn(binary, args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          command: displayCommand,
          cwd: options.cwd,
          code: -1,
          stdout,
          stderr: `${stderr}${error.message}`,
          timedOut,
          durationMs: Date.now() - startedAt
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          command: displayCommand,
          cwd: options.cwd,
          code,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          timedOut,
          durationMs: Date.now() - startedAt
        });
      });
    });
  }
}
