# Push-to-Talk Voice Transcription

Voice-to-text input for the mobile composer. Tap the mic button to record, tap again to stop — the audio is sent to the Rust bridge which calls OpenAI's transcription API and returns the text into the composer.

## Architecture

```
Phone (expo-audio)        Rust Bridge              OpenAI
  record WAV 16kHz mono --> base64 over WebSocket --> POST /v1/audio/transcriptions
  insert text in composer <-- { text: "..." }    <-- gpt-4o-transcribe response
```

The flow mirrors Codex CLI 0.105.0's TUI push-to-talk feature — same API, same model (`gpt-4o-transcribe`), same auth. The bridge acts as the HTTP proxy since the phone doesn't hold API keys directly.

## Auth Resolution

The bridge resolves transcription credentials in order:

1. `OPENAI_API_KEY` env var → `https://api.openai.com/v1/audio/transcriptions` (model: `gpt-4o-transcribe`)
2. `BRIDGE_CHATGPT_ACCESS_TOKEN` env var → `https://chatgpt.com/backend-api/transcribe` (no model param)
3. `~/.codex/auth.json` fallback:
   - `OPENAI_API_KEY` field present → same as path 1
   - `auth_mode: "chatgpt"` with `tokens.access_token` → same as path 2

## Files

### Rust Bridge

| File | What |
|------|------|
| `services/rust-bridge/Cargo.toml` | Added `reqwest` (multipart, json, rustls-tls) |
| `services/rust-bridge/src/main.rs` | `bridge/voice/transcribe` JSON-RPC method, `transcribe_voice()`, `resolve_transcription_auth()`, `resolve_codex_auth_json_path()` |

### Mobile

| File | What |
|------|------|
| `apps/mobile/app.json` | `NSMicrophoneUsageDescription` (iOS), `RECORD_AUDIO` permission (Android), `expo-audio` plugin |
| `apps/mobile/src/api/types.ts` | `VoiceTranscribeRequest`, `VoiceTranscribeResponse` |
| `apps/mobile/src/api/client.ts` | `transcribeVoice()` method on `HostBridgeApiClient` |
| `apps/mobile/src/hooks/useVoiceRecorder.ts` | Recording state machine hook using `expo-audio` |
| `apps/mobile/src/components/ChatInput.tsx` | Mic button UI with three visual states |
| `apps/mobile/src/screens/MainScreen.tsx` | Wires hook to ChatInput |

## Recording Config

- Sample rate: 16,000 Hz
- Channels: 1 (mono)
- Format: LINEARPCM 16-bit (iOS), default WAV (Android)
- Extension: `.wav`
- Minimum duration: 1 second

## UI States

The mic button occupies the send button slot when the composer is empty and no turn is running:

| State | Icon | Style |
|-------|------|-------|
| Idle | `mic-outline` | Muted color |
| Recording | `mic` | Red icon, red border |
| Transcribing | `ActivityIndicator` | Spinner |

Interaction: tap to start recording, tap again to stop and transcribe. The transcribed text is appended to the current draft.

## Dependencies

- **`expo-audio`** — Recording via `useAudioRecorder` hook. Works in Expo Go (unlike `expo-av` which requires a dev build in SDK 55).
- **`reqwest`** (Rust) — HTTP client for the multipart POST to OpenAI. Uses `rustls-tls` to avoid native-tls linking issues on macOS.

## Error Handling

- Mic permission denied → error message, stays idle
- Recording < 1 second → "Recording too short" error, discarded
- Audio payload < 16KB → bridge rejects with `invalid_params`
- No credentials found → bridge returns error code `-32002`
- Transcription API HTTP error → bridge returns status + body in error data
