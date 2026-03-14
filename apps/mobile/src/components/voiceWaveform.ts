export const VOICE_WAVEFORM_BAR_COUNT = 28;
export const VOICE_WAVEFORM_SAMPLE_INTERVAL_MS = 80;

const METERING_FLOOR_DB = -55;

export function createVoiceWaveformSeed(barCount: number): number[] {
  return Array.from({ length: Math.max(1, barCount) }, () => 0);
}

export function appendVoiceWaveformSample(
  previousSamples: number[],
  nextSample: number,
  maxBars: number
): number[] {
  const trimmedSamples = previousSamples.slice(-(Math.max(1, maxBars) - 1));
  return [...trimmedSamples, clampWaveformLevel(nextSample)];
}

export function normalizeVoiceMetering(metering: number | null | undefined): number {
  if (typeof metering !== 'number' || Number.isNaN(metering)) {
    return 0;
  }

  const clampedMetering = Math.max(METERING_FLOOR_DB, Math.min(0, metering));
  const normalizedLevel = (clampedMetering - METERING_FLOOR_DB) / Math.abs(METERING_FLOOR_DB);
  return clampWaveformLevel(Math.pow(normalizedLevel, 0.65));
}

export function fallbackVoiceWaveformLevel(step: number): number {
  const oscillation = Math.abs(Math.sin(step / 2.35));
  return clampWaveformLevel(0.12 + oscillation * 0.24);
}

export function formatVoiceRecordingDuration(durationMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clampWaveformLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.max(0, Math.min(1, level));
}
