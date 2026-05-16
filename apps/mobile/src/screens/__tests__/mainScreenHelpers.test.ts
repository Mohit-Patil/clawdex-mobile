import {
  extractCodexFailureMessage,
  formatGitCloneFailureMessage,
} from '../mainScreenHelpers';

describe('mainScreenHelpers', () => {
  it('keeps successful git clone responses quiet', () => {
    expect(
      formatGitCloneFailureMessage({
        code: 0,
        stdout: '',
        stderr: '',
        cloned: true,
      })
    ).toBeNull();
  });

  it('surfaces git stderr when clone exits unsuccessfully', () => {
    expect(
      formatGitCloneFailureMessage({
        code: 128,
        stdout: '',
        stderr: 'fatal: repository not found',
        cloned: false,
      })
    ).toBe('fatal: repository not found');
  });

  it('falls back to a readable clone failure when git gives no output', () => {
    expect(
      formatGitCloneFailureMessage(
        {
          code: 1,
          stdout: '',
          stderr: '',
          cloned: false,
        },
        'Mohit-Patil/launchkit'
      )
    ).toBe('Git clone failed for Mohit-Patil/launchkit.');
  });

  it('extracts nested Codex failure details from live event payloads', () => {
    expect(
      extractCodexFailureMessage({
        msg: {
          status: {
            error: {
              details: {
                stderr: 'model quota exceeded',
              },
            },
          },
        },
      })
    ).toBe('model quota exceeded');
  });
});
