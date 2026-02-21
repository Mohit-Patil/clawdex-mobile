import { spawn } from 'node:child_process';

import type { TerminalExecResponse } from '../types';

interface ExecuteOptions {
  cwd: string;
  timeoutMs?: number;
}

interface TerminalServiceOptions {
  allowedCommands?: Iterable<string>;
}

interface ParsedCommand {
  binary: string;
  args: string[];
}

export class TerminalCommandRejectedError extends Error {
  readonly code = 'terminal_command_rejected';

  constructor(message: string) {
    super(message);
    this.name = 'TerminalCommandRejectedError';
  }
}

export class TerminalService {
  private readonly allowedCommands: ReadonlySet<string>;

  constructor(options: TerminalServiceOptions = {}) {
    const allowed = new Set<string>();
    for (const command of options.allowedCommands ?? []) {
      const normalized = command.trim();
      if (normalized.length > 0) {
        allowed.add(normalized);
      }
    }
    this.allowedCommands = allowed;
  }

  async executeShell(
    command: string,
    options: ExecuteOptions
  ): Promise<TerminalExecResponse> {
    const parsed = this.parseUserCommand(command);
    return this.run(parsed.binary, parsed.args, command, options);
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

  private parseUserCommand(command: string): ParsedCommand {
    const tokens = tokenizeCommand(command);
    const [binary, ...args] = tokens;
    if (!binary) {
      throw new TerminalCommandRejectedError('Command is empty.');
    }

    if (
      this.allowedCommands.size > 0 &&
      !this.allowedCommands.has(binary)
    ) {
      const allowed = [...this.allowedCommands].sort().join(', ');
      throw new TerminalCommandRejectedError(
        `Command "${binary}" is not allowed. Allowed commands: ${allowed}`
      );
    }

    return { binary, args };
  }
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && quote === '"') {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (isWhitespace(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (isDisallowedControlChar(char)) {
      throw new TerminalCommandRejectedError(
        `Disallowed control character "${char}" in command.`
      );
    }

    current += char;
  }

  if (escaping) {
    throw new TerminalCommandRejectedError('Command ends with a dangling escape character.');
  }

  if (quote) {
    throw new TerminalCommandRejectedError('Unterminated quoted string in command.');
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new TerminalCommandRejectedError('Command is empty.');
  }

  return tokens;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isDisallowedControlChar(char: string): boolean {
  return (
    char === ';' ||
    char === '|' ||
    char === '&' ||
    char === '<' ||
    char === '>' ||
    char === '`'
  );
}
