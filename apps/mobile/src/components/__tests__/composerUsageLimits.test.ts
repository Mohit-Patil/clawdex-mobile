import {
  buildComposerUsageLimitBadges,
  formatComposerUsageLimitLabel,
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
        tone: 'neutral',
      },
      {
        id: 'secondary',
        label: 'weekly',
        remainingPercent: 21,
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
        tone: 'critical',
      },
      {
        id: 'secondary',
        label: '1d',
        remainingPercent: 10,
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
        tone: 'neutral',
      },
      {
        id: 'secondary',
        label: 'weekly',
        remainingPercent: 18,
        tone: 'warning',
      },
    ]);
  });
});
