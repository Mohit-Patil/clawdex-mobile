import {
  buildComposerUsageLimitAlert,
  buildComposerUsageLimitBadges,
  formatComposerUsageLimitLabel,
  formatComposerUsageLimitResetAt,
} from '../usageLimitBadges';

describe('composerUsageLimits', () => {
  it('maps primary and secondary windows into remaining-percentage badges', () => {
    const badges = buildComposerUsageLimitBadges({
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'plus',
      credits: null,
      primary: {
        usedPercent: 34,
        windowDurationMins: 300,
        resetsAt: 1_700_000_000,
      },
      secondary: {
        usedPercent: 79,
        windowDurationMins: 10_080,
        resetsAt: 1_700_000_100,
      },
    });

    expect(badges).toEqual([
      {
        id: 'primary',
        label: '5h',
        remainingPercent: 66,
        resetsAt: 1_700_000_000,
        tone: 'neutral',
      },
      {
        id: 'secondary',
        label: 'weekly',
        remainingPercent: 21,
        resetsAt: 1_700_000_100,
        tone: 'warning',
      },
    ]);
  });

  it('clamps remaining percent and escalates critical limits', () => {
    const badges = buildComposerUsageLimitBadges({
      limitId: 'codex',
      limitName: null,
      planType: 'pro',
      credits: null,
      primary: {
        usedPercent: 140,
        windowDurationMins: 60,
        resetsAt: null,
      },
      secondary: {
        usedPercent: 89.6,
        windowDurationMins: 1_440,
        resetsAt: null,
      },
    });

    expect(badges).toEqual([
      {
        id: 'primary',
        label: '1h',
        remainingPercent: 0,
        resetsAt: null,
        tone: 'critical',
      },
      {
        id: 'secondary',
        label: '1d',
        remainingPercent: 10,
        resetsAt: null,
        tone: 'critical',
      },
    ]);
  });

  it('omits missing windows', () => {
    const badges = buildComposerUsageLimitBadges({
      limitId: 'codex',
      limitName: null,
      planType: 'team',
      credits: null,
      primary: null,
      secondary: {
        usedPercent: 45,
        windowDurationMins: 120,
        resetsAt: null,
      },
    });

    expect(badges).toEqual([
      {
        id: 'secondary',
        label: '2h',
        remainingPercent: 55,
        resetsAt: null,
        tone: 'neutral',
      },
    ]);
  });

  it('formats generic duration labels', () => {
    expect(formatComposerUsageLimitLabel(45)).toBe('45m');
    expect(formatComposerUsageLimitLabel(720)).toBe('12h');
    expect(formatComposerUsageLimitLabel(2_880)).toBe('2d');
  });

  it('falls back to 5h and weekly for the default codex pair when duration is omitted', () => {
    const badges = buildComposerUsageLimitBadges({
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'plus',
      credits: null,
      primary: {
        usedPercent: 31,
        windowDurationMins: null,
        resetsAt: 1_700_000_000,
      },
      secondary: {
        usedPercent: 82,
        windowDurationMins: null,
        resetsAt: 1_700_000_100,
      },
    });

    expect(badges).toEqual([
      {
        id: 'primary',
        label: '5h',
        remainingPercent: 69,
        resetsAt: 1_700_000_000,
        tone: 'neutral',
      },
      {
        id: 'secondary',
        label: 'weekly',
        remainingPercent: 18,
        resetsAt: 1_700_000_100,
        tone: 'warning',
      },
    ]);
  });

  it('formats reset timestamps in local-friendly text', () => {
    expect(
      formatComposerUsageLimitResetAt(1_700_000_000, {
        locale: 'en-US',
        timeZone: 'UTC',
      })
    ).toBe('Tue, Nov 14, 10:13 PM');
    expect(formatComposerUsageLimitResetAt(null)).toBe('Unknown');
  });

  it('builds an alert when a usage limit is exhausted', () => {
    const resetAt = 1_700_000_000;
    const alert = buildComposerUsageLimitAlert({
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'plus',
      credits: null,
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: resetAt,
      },
      secondary: {
        usedPercent: 45,
        windowDurationMins: 10_080,
        resetsAt: 1_700_000_100,
      },
    });

    expect(alert).toEqual({
      title: 'Rate limit reached',
      body: 'Your 5h Codex limit has been reached. Try again after the reset.',
      status: `Resets ${formatComposerUsageLimitResetAt(resetAt)}.`,
    });
  });

  it('does not build an alert when limits still have capacity', () => {
    expect(
      buildComposerUsageLimitAlert({
        limitId: 'codex',
        limitName: 'Codex',
        planType: 'plus',
        credits: null,
        primary: {
          usedPercent: 80,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
      })
    ).toBeNull();
  });
});
