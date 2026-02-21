import {
  TerminalCommandRejectedError,
  TerminalService
} from '../terminalService';

describe('TerminalService', () => {
  const cwd = process.cwd();

  it('executes an allowlisted command', async () => {
    const terminal = new TerminalService({
      allowedCommands: ['pwd']
    });

    const result = await terminal.executeShell('pwd', { cwd });

    expect(result.code).toBe(0);
    expect(result.command).toBe('pwd');
    expect(result.cwd).toBe(cwd);
  });

  it('rejects commands outside the allowlist', async () => {
    const terminal = new TerminalService({
      allowedCommands: ['pwd']
    });

    await expect(
      terminal.executeShell('ls', { cwd })
    ).rejects.toBeInstanceOf(TerminalCommandRejectedError);
  });

  it('rejects shell control characters in user command input', async () => {
    const terminal = new TerminalService({
      allowedCommands: ['pwd', 'ls']
    });

    await expect(
      terminal.executeShell('pwd && ls', { cwd })
    ).rejects.toThrow('Disallowed control character');
  });

  it('supports quoted arguments', async () => {
    const terminal = new TerminalService({
      allowedCommands: ['echo']
    });

    const result = await terminal.executeShell('echo "hello world"', { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello world');
  });
});
