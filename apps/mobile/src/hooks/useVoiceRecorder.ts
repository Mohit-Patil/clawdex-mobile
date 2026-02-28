import {
  type AudioRecorder,
  type RecordingOptions,
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceRecorderOptions {
  transcribe: (
    dataBase64: string,
    prompt?: string,
    options?: {
      fileName?: string;
      mimeType?: string;
    }
  ) => Promise<{ text: string }>;
  composerContext?: string;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

const MIN_RECORDING_DURATION_MS = 1_000;
const MAX_RECORDING_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RECORDING_FILE_MB = MAX_RECORDING_FILE_BYTES / (1024 * 1024);

const RECORDING_OPTIONS: RecordingOptions = {
  isMeteringEnabled: false,
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    sampleRate: 16_000,
  },
  ios: {
    extension: '.wav',
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    sampleRate: 16_000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 256_000,
  },
};

function estimateBase64DecodedSize(base64: string): number {
  const payload = base64.split(',').pop()?.trim() ?? '';
  if (!payload) {
    return 0;
  }

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const blockCount = Math.ceil(payload.length / 4);
  return Math.max(0, blockCount * 3 - padding);
}

function getTranscriptionUploadMetadata(): { fileName: string; mimeType: string } {
  if (Platform.OS === 'ios') {
    return { fileName: 'audio.wav', mimeType: 'audio/wav' };
  }
  if (Platform.OS === 'android') {
    return { fileName: 'audio.m4a', mimeType: 'audio/mp4' };
  }
  return { fileName: 'audio.webm', mimeType: 'audio/webm' };
}

async function deleteRecordingFile(uri: string | null | undefined): Promise<void> {
  const normalized = uri?.trim();
  if (!normalized) {
    return;
  }
  await FileSystem.deleteAsync(normalized, { idempotent: true }).catch(() => {});
}

export function useVoiceRecorder({
  transcribe,
  composerContext,
  onTranscript,
  onError,
}: UseVoiceRecorderOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const startTimeRef = useRef<number>(0);
  const recorderRef = useRef<AudioRecorder>(recorder);
  recorderRef.current = recorder;

  const startRecording = useCallback(async () => {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        onError('Microphone permission is required for voice input.');
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await recorderRef.current.prepareToRecordAsync();
      recorderRef.current.record();
      startTimeRef.current = Date.now();
      setVoiceState('recording');
    } catch (err) {
      await setAudioModeAsync({
        allowsRecording: false,
      }).catch(() => {});
      onError(`Failed to start recording: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [onError]);

  const stopRecordingAndTranscribe = useCallback(async () => {
    const currentRecorder = recorderRef.current;
    if (!currentRecorder.isRecording) {
      setVoiceState('idle');
      return;
    }

    let recordingUriToClean: string | null = null;

    try {
      const elapsed = Date.now() - startTimeRef.current;
      await currentRecorder.stop();

      await setAudioModeAsync({
        allowsRecording: false,
      });

      if (elapsed < MIN_RECORDING_DURATION_MS) {
        onError('Recording too short — hold longer to record.');
        setVoiceState('idle');
        return;
      }

      const uri = currentRecorder.uri;
      if (!uri) {
        onError('Recording failed — no audio file produced.');
        setVoiceState('idle');
        return;
      }
      recordingUriToClean = uri;

      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (!fileInfo.exists || fileInfo.isDirectory) {
        onError('Recording failed — audio file is unavailable.');
        setVoiceState('idle');
        return;
      }
      if (fileInfo.size > MAX_RECORDING_FILE_BYTES) {
        onError(`Recording too long — maximum size is ${String(MAX_RECORDING_FILE_MB)}MB.`);
        setVoiceState('idle');
        return;
      }

      setVoiceState('transcribing');

      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (estimateBase64DecodedSize(base64) > MAX_RECORDING_FILE_BYTES) {
        onError(`Recording too long — maximum size is ${String(MAX_RECORDING_FILE_MB)}MB.`);
        setVoiceState('idle');
        return;
      }

      const prompt = composerContext?.trim() || undefined;
      const result = await transcribe(base64, prompt, getTranscriptionUploadMetadata());

      const text = result.text.trim();
      if (text) {
        onTranscript(text);
      }
    } catch (err) {
      onError(
        `Transcription failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await deleteRecordingFile(recordingUriToClean);
      setVoiceState('idle');
    }
  }, [composerContext, onError, onTranscript, transcribe]);

  const cancelRecording = useCallback(async () => {
    const currentRecorder = recorderRef.current;
    let recordingUri = currentRecorder.uri;
    try {
      await currentRecorder.stop();
      recordingUri = currentRecorder.uri ?? recordingUri;
    } catch {
      // Best effort — recording may already be stopped.
    }

    await setAudioModeAsync({
      allowsRecording: false,
    }).catch(() => {});
    await deleteRecordingFile(recordingUri);

    setVoiceState('idle');
  }, []);

  const toggleRecording = useCallback(() => {
    if (voiceState === 'recording') {
      void stopRecordingAndTranscribe();
    } else if (voiceState === 'idle') {
      void startRecording();
    }
  }, [voiceState, startRecording, stopRecordingAndTranscribe]);

  useEffect(() => {
    return () => {
      const currentRecorder = recorderRef.current;
      void (async () => {
        let recordingUri = currentRecorder.uri;
        try {
          await currentRecorder.stop();
          recordingUri = currentRecorder.uri ?? recordingUri;
        } catch {
          // Best effort on unmount.
        }
        await deleteRecordingFile(recordingUri);
      })();
      void setAudioModeAsync({
        allowsRecording: false,
      }).catch(() => {});
    };
  }, []);

  return {
    voiceState,
    startRecording,
    stopRecordingAndTranscribe,
    cancelRecording,
    toggleRecording,
  };
}
