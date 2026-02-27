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
import { useCallback, useRef, useState } from 'react';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceRecorderOptions {
  transcribe: (dataBase64: string, prompt?: string) => Promise<{ text: string }>;
  composerContext?: string;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

const MIN_RECORDING_DURATION_MS = 1_000;

const RECORDING_OPTIONS: RecordingOptions = {
  isMeteringEnabled: false,
  extension: '.wav',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  android: {
    extension: '.wav',
    outputFormat: 'default',
    audioEncoder: 'default',
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
    mimeType: 'audio/wav',
    bitsPerSecond: 256_000,
  },
};

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
      onError(`Failed to start recording: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [onError]);

  const stopRecordingAndTranscribe = useCallback(async () => {
    const currentRecorder = recorderRef.current;
    if (!currentRecorder.isRecording) {
      setVoiceState('idle');
      return;
    }

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

      setVoiceState('transcribing');

      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const prompt = composerContext?.trim() || undefined;
      const result = await transcribe(base64, prompt);

      const text = result.text.trim();
      if (text) {
        onTranscript(text);
      }
    } catch (err) {
      onError(
        `Transcription failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setVoiceState('idle');
    }
  }, [composerContext, onError, onTranscript, transcribe]);

  const cancelRecording = useCallback(async () => {
    try {
      await recorderRef.current.stop();
    } catch {
      // Best effort — recording may already be stopped.
    }

    await setAudioModeAsync({
      allowsRecording: false,
    }).catch(() => {});

    setVoiceState('idle');
  }, []);

  const toggleRecording = useCallback(() => {
    if (voiceState === 'recording') {
      void stopRecordingAndTranscribe();
    } else if (voiceState === 'idle') {
      void startRecording();
    }
  }, [voiceState, startRecording, stopRecordingAndTranscribe]);

  return {
    voiceState,
    startRecording,
    stopRecordingAndTranscribe,
    cancelRecording,
    toggleRecording,
  };
}
