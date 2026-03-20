import {
  appendVoiceWaveformSample,
  fallbackVoiceWaveformLevel,
  formatVoiceRecordingDuration,
  normalizeVoiceMetering,
} from '../voiceWaveform';

describe('voiceWaveform', () => {
  it('formats recording duration as mm:ss', () => {
    expect(formatVoiceRecordingDuration(0)).toBe('00:00');
    expect(formatVoiceRecordingDuration(9_000)).toBe('00:09');
    expect(formatVoiceRecordingDuration(65_000)).toBe('01:05');
  });

  it('normalizes metering into a bounded waveform level', () => {
    expect(normalizeVoiceMetering(undefined)).toBe(0);
    expect(normalizeVoiceMetering(-160)).toBe(0);
    expect(normalizeVoiceMetering(5)).toBe(1);
    expect(normalizeVoiceMetering(-5)).toBeGreaterThan(normalizeVoiceMetering(-35));
  });

  it('keeps only the newest waveform samples', () => {
    expect(appendVoiceWaveformSample([0.1, 0.2], 0.3, 4)).toEqual([0.1, 0.2, 0.3]);
    expect(appendVoiceWaveformSample([0.1, 0.2, 0.3], 0.4, 3)).toEqual([0.2, 0.3, 0.4]);
  });

  it('provides a subtle fallback waveform level when metering is unavailable', () => {
    expect(fallbackVoiceWaveformLevel(0)).toBeGreaterThan(0);
    expect(fallbackVoiceWaveformLevel(10)).toBeLessThanOrEqual(1);
  });
});
