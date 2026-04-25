import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Terminal as HeadlessTerminal } from 'xterm-headless';

import ClawdexTerminalModule, {
  ClawdexTerminalView,
  type TerminalReadyEventPayload,
  type TerminalRendererInfo,
  type TerminalResizeEventPayload,
  type TerminalWriteFrame,
} from '../../modules/clawdex-terminal';
import type { HostBridgeApiClient } from '../api/client';
import type { TerminalSessionSnapshot } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { useAppTheme, type AppTheme } from '../theme';

interface TerminalScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  onOpenDrawer: () => void;
}

const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;
const FALLBACK_CELL_WIDTH = 7.8;
const FALLBACK_CELL_HEIGHT = 19;
const FALLBACK_MIN_COLS = 24;
const FALLBACK_MIN_ROWS = 8;
const TERMINAL_INPUT_BATCH_MS = 8;
const TERMINAL_SHORTCUTS = [
  { label: 'Esc', input: '\u001B' },
  { label: 'Tab', input: '\t' },
  { label: 'Ctrl C', input: '\u0003' },
  { label: 'Ctrl D', input: '\u0004' },
  { label: '←', input: '\u001B[D' },
  { label: '↑', input: '\u001B[A' },
  { label: '↓', input: '\u001B[B' },
  { label: '→', input: '\u001B[C' },
] as const;

type HeadlessTerminalInstance = InstanceType<typeof HeadlessTerminal>;

interface TerminalFrame {
  lines: string[];
  cursorX: number;
  cursorY: number;
  cols: number;
  rows: number;
}

interface TerminalGridSize {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export function TerminalScreen({ api, ws, onOpenDrawer }: TerminalScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [rendererInfo, setRendererInfo] = useState<TerminalRendererInfo>(() =>
    getInitialRendererInfo()
  );
  const [writeFrame, setWriteFrame] = useState<TerminalWriteFrame | null>(null);
  const [fallbackFrame, setFallbackFrame] = useState<TerminalFrame>(() =>
    createEmptyTerminalFrame(INITIAL_COLS, INITIAL_ROWS)
  );
  const [terminalInputValue, setTerminalInputValue] = useState('');
  const [terminalFocused, setTerminalFocused] = useState(false);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const fallbackTerminalRef = useRef<HeadlessTerminalInstance | null>(null);
  const terminalInputRef = useRef<TextInput | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const nativeRendererActiveRef = useRef(rendererInfo.available);
  const pendingNativeChunksRef = useRef<string[]>([]);
  const nativeFlushFrameRef = useRef<number | null>(null);
  const pendingInputRef = useRef<string[]>([]);
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResizeKeyRef = useRef<string | null>(null);
  const terminalGridSizeRef = useRef<TerminalGridSize>({
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    pixelWidth: 0,
    pixelHeight: 0,
  });

  const getFallbackTerminal = useCallback(() => {
    if (!fallbackTerminalRef.current) {
      const { cols, rows } = terminalGridSizeRef.current;
      fallbackTerminalRef.current = new HeadlessTerminal({
        allowProposedApi: true,
        cols,
        rows,
        cursorBlink: false,
        cursorStyle: 'block',
        scrollback: 2000,
      });
    }
    return fallbackTerminalRef.current;
  }, []);

  useEffect(() => {
    nativeRendererActiveRef.current = rendererInfo.available;
  }, [rendererInfo.available]);

  const writeTerminalOutput = useCallback((chunk: string) => {
    if (!chunk) {
      return;
    }

    const terminal = getFallbackTerminal();
    terminal.write(chunk, () => {
      setFallbackFrame(readTerminalFrame(terminal));
    });
  }, [getFallbackTerminal]);

  const flushNativeWriteFrame = useCallback(() => {
    nativeFlushFrameRef.current = null;
    const chunks = pendingNativeChunksRef.current.splice(0);
    if (chunks.length === 0) {
      return;
    }

    const dataBase64 = chunks.length === 1 ? chunks[0] : concatTerminalBase64Chunks(chunks);
    setWriteFrame((previous) => ({
      seq: previous ? previous.seq + 1 : 1,
      dataBase64,
    }));
  }, []);

  const pushNativeWriteFrame = useCallback((dataBase64: string) => {
    if (!dataBase64) {
      return;
    }

    pendingNativeChunksRef.current.push(dataBase64);
    if (nativeFlushFrameRef.current !== null) {
      return;
    }

    nativeFlushFrameRef.current = requestAnimationFrame(flushNativeWriteFrame);
  }, [flushNativeWriteFrame]);

  const flushTerminalInput = useCallback(() => {
    inputFlushTimerRef.current = null;
    const input = pendingInputRef.current.join('');
    pendingInputRef.current.length = 0;

    const sessionId = sessionIdRef.current;
    if (!input || !sessionId || starting || !session?.active) {
      return;
    }

    void api
      .sendTerminalSessionInput({
        sessionId,
        dataBase64: encodeTerminalInput(input),
      })
      .then(() => {
        setError(null);
      })
      .catch((err) => {
        setError((err as Error).message);
      });
  }, [api, session?.active, starting]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = ws.onEvent((event) => {
      const payload = event.params;
      const payloadSessionId =
        typeof payload?.sessionId === 'string' ? payload.sessionId : null;

      if (!payloadSessionId || payloadSessionId !== sessionIdRef.current) {
        return;
      }

      if (event.method === 'bridge/terminal/session/data') {
        const dataBase64 =
          typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : null;
        if (!dataBase64) {
          return;
        }
        if (nativeRendererActiveRef.current) {
          pushNativeWriteFrame(dataBase64);
        } else {
          writeTerminalOutput(decodeTerminalBase64Chunk(dataBase64, decoderRef.current));
        }
        return;
      }

      if (event.method === 'bridge/terminal/session/error') {
        const message = typeof payload?.message === 'string' ? payload.message : 'Terminal error';
        setError(message);
        return;
      }

      if (event.method === 'bridge/terminal/session/exit') {
        const exitCode =
          typeof payload?.exitCode === 'number' || payload?.exitCode === null
            ? payload.exitCode
            : null;
        const exitSignal =
          typeof payload?.exitSignal === 'string' ? payload.exitSignal : null;
        const lastError =
          typeof payload?.lastError === 'string' ? payload.lastError : null;
        setSession((previous) =>
          previous
            ? {
                ...previous,
                active: false,
                exitedAt: typeof payload?.exitedAt === 'string' ? payload.exitedAt : previous.exitedAt,
                exitCode,
                exitSignal,
                lastError: lastError ?? previous.lastError,
              }
            : previous
        );
        if (lastError) {
          setError(lastError);
        }
        if (!nativeRendererActiveRef.current) {
          writeTerminalOutput(
            `\n\n[session exited${exitSignal ? `: ${exitSignal}` : exitCode !== null ? `: ${String(exitCode)}` : ''}]\n`
          );
        }
      }
    });

    void (async () => {
      try {
        const { cols, rows, pixelWidth, pixelHeight } = terminalGridSizeRef.current;
        const created = await api.createTerminalSession({
          cols,
          rows,
          pixelWidth,
          pixelHeight,
        });
        if (disposed) {
          await api.closeTerminalSession({ sessionId: created.id }).catch(() => undefined);
          return;
        }

        sessionIdRef.current = created.id;
        setSession(created);
        const snapshot = await api.readTerminalSession({ sessionId: created.id });
        if (disposed) {
          return;
        }
        setSession(snapshot);
        if (snapshot.outputBase64) {
          if (nativeRendererActiveRef.current) {
            pushNativeWriteFrame(snapshot.outputBase64);
          } else {
            const fullText = decodeTerminalBase64Chunk(snapshot.outputBase64, new TextDecoder());
            writeTerminalOutput(fullText);
          }
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!disposed) {
          setStarting(false);
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) {
        void api.closeTerminalSession({ sessionId }).catch(() => undefined);
      }
      fallbackTerminalRef.current?.dispose();
      fallbackTerminalRef.current = null;
      if (nativeFlushFrameRef.current !== null) {
        cancelAnimationFrame(nativeFlushFrameRef.current);
        nativeFlushFrameRef.current = null;
      }
      pendingNativeChunksRef.current.length = 0;
      if (inputFlushTimerRef.current !== null) {
        clearTimeout(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }
      pendingInputRef.current.length = 0;
    };
  }, [api, pushNativeWriteFrame, writeTerminalOutput, ws]);

  const handleRendererReady = useCallback((event: { nativeEvent: TerminalReadyEventPayload }) => {
    setRendererInfo(normalizeRendererInfo(event.nativeEvent));
  }, []);

  const handleRendererResize = useCallback(
    (event: { nativeEvent: TerminalResizeEventPayload }) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || !session?.active) {
        return;
      }

      const cols = Math.max(2, Math.floor(event.nativeEvent.cols));
      const rows = Math.max(1, Math.floor(event.nativeEvent.rows));
      const pixelWidth = Math.max(0, Math.floor(event.nativeEvent.pixelWidth));
      const pixelHeight = Math.max(0, Math.floor(event.nativeEvent.pixelHeight));
      const resizeKey = `${cols}x${rows}:${pixelWidth}x${pixelHeight}`;
      if (resizeKey === lastResizeKeyRef.current) {
        return;
      }

      lastResizeKeyRef.current = resizeKey;
      setSession((previous) =>
        previous
          ? {
              ...previous,
              cols,
              rows,
              pixelWidth,
              pixelHeight,
            }
          : previous
      );

      void api
        .resizeTerminalSession({
          sessionId,
          cols,
          rows,
          pixelWidth,
          pixelHeight,
        })
        .catch((err) => {
          setError((err as Error).message);
        });
    },
    [api, session?.active]
  );

  const resizeFallbackTerminal = useCallback(
    ({ cols, rows, pixelWidth, pixelHeight }: TerminalGridSize) => {
      const previous = terminalGridSizeRef.current;
      const resizeKey = `${cols}x${rows}:${pixelWidth}x${pixelHeight}`;
      if (
        previous.cols === cols &&
        previous.rows === rows &&
        previous.pixelWidth === pixelWidth &&
        previous.pixelHeight === pixelHeight
      ) {
        return;
      }

      terminalGridSizeRef.current = {
        cols,
        rows,
        pixelWidth,
        pixelHeight,
      };

      const terminal = getFallbackTerminal();
      terminal.resize(cols, rows);
      setFallbackFrame(readTerminalFrame(terminal));

      const sessionId = sessionIdRef.current;
      if (!sessionId || !session?.active || resizeKey === lastResizeKeyRef.current) {
        return;
      }

      lastResizeKeyRef.current = resizeKey;
      setSession((previousSession) =>
        previousSession
          ? {
              ...previousSession,
              cols,
              rows,
              pixelWidth,
              pixelHeight,
            }
          : previousSession
      );

      void api
        .resizeTerminalSession({
          sessionId,
          cols,
          rows,
          pixelWidth,
          pixelHeight,
        })
        .catch((err) => {
          setError((err as Error).message);
        });
    },
    [api, getFallbackTerminal, session?.active]
  );

  const handleFallbackViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const pixelWidth = Math.max(0, Math.floor(event.nativeEvent.layout.width));
      const pixelHeight = Math.max(0, Math.floor(event.nativeEvent.layout.height));
      if (pixelWidth <= 0 || pixelHeight <= 0) {
        return;
      }

      resizeFallbackTerminal({
        cols: Math.max(
          FALLBACK_MIN_COLS,
          Math.floor((pixelWidth - theme.spacing.md * 2) / FALLBACK_CELL_WIDTH)
        ),
        rows: Math.max(
          FALLBACK_MIN_ROWS,
          Math.floor((pixelHeight - theme.spacing.md * 2) / FALLBACK_CELL_HEIGHT)
        ),
        pixelWidth,
        pixelHeight,
      });
    },
    [resizeFallbackTerminal, theme.spacing.md]
  );

  const writeTerminalInput = useCallback((input: string) => {
    const sessionId = sessionIdRef.current;
    if (!input || !sessionId || starting || !session?.active) {
      return;
    }

    pendingInputRef.current.push(input);
    if (inputFlushTimerRef.current !== null) {
      return;
    }
    inputFlushTimerRef.current = setTimeout(flushTerminalInput, TERMINAL_INPUT_BATCH_MS);
  }, [flushTerminalInput, session?.active, starting]);

  const focusTerminalInput = useCallback(() => {
    if (starting || !session?.active) {
      return;
    }

    terminalInputRef.current?.focus();
  }, [session?.active, starting]);

  const handleTerminalTextChange = useCallback(
    (value: string) => {
      if (value) {
        writeTerminalInput(value.replace(/\n/g, '\r'));
      }
      setTerminalInputValue('');
    },
    [writeTerminalInput]
  );

  const handleTerminalKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === 'Backspace') {
        writeTerminalInput('\u007F');
        setTerminalInputValue('');
      }
    },
    [writeTerminalInput]
  );

  const handleTerminalSubmit = useCallback(() => {
    writeTerminalInput('\r');
    setTerminalInputValue('');
  }, [writeTerminalInput]);

  const statusText = session
    ? session.active
      ? 'Live session'
      : 'Exited'
    : starting
      ? 'Starting session'
      : 'Session unavailable';

  const isNativeRendererActive = rendererInfo.available;
  const headerDetailText = session
    ? `${session.shell.split('/').pop() ?? session.shell} · ${session.cols}x${session.rows}`
    : statusText;
  const fallbackRows = fallbackFrame.lines.length > 0
    ? fallbackFrame.lines
    : [starting ? 'Starting terminal session...' : 'Session started.'];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
          <Ionicons name="menu" size={22} color={theme.colors.textMuted} />
        </Pressable>
        <Ionicons name="terminal" size={16} color={theme.colors.textMuted} />
        <Text style={styles.headerTitle}>Terminal</Text>
        <View style={styles.headerStatus}>
          {starting ? <Ionicons name="sync" size={14} color={theme.colors.textMuted} /> : null}
          <Text style={styles.headerStatusText}>{headerDetailText}</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.terminalWindow}>
          <Pressable
            style={[
              styles.terminalViewport,
              terminalFocused && styles.terminalViewportFocused,
            ]}
            onLayout={isNativeRendererActive ? undefined : handleFallbackViewportLayout}
            onPress={focusTerminalInput}
          >
            {isNativeRendererActive ? (
              <ClawdexTerminalView
                style={styles.nativeRenderer}
                sessionId={session?.id ?? null}
                cols={session?.cols ?? INITIAL_COLS}
                rows={session?.rows ?? INITIAL_ROWS}
                writeFrame={writeFrame}
                placeholderText="Waiting for terminal output…"
                onReady={handleRendererReady}
                onTerminalResize={handleRendererResize}
              />
            ) : (
              <View style={styles.output}>
                {fallbackRows.map((line, rowIndex) => (
                  <TerminalLine
                    key={`terminal-row-${String(rowIndex)}`}
                    cols={fallbackFrame.cols}
                    cursorX={fallbackFrame.cursorX}
                    isCursorRow={
                      session?.active === true && rowIndex === fallbackFrame.cursorY
                    }
                    line={line}
                    styles={styles}
                  />
                ))}
              </View>
            )}
            <TextInput
              ref={terminalInputRef}
              value={terminalInputValue}
              onChangeText={handleTerminalTextChange}
              onKeyPress={handleTerminalKeyPress}
              onSubmitEditing={handleTerminalSubmit}
              onFocus={() => setTerminalFocused(true)}
              onBlur={() => setTerminalFocused(false)}
              keyboardAppearance={theme.keyboardAppearance}
              keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'default'}
              autoCapitalize="none"
              autoCorrect={false}
              blurOnSubmit={false}
              editable={!starting && Boolean(session?.active)}
              importantForAutofill="no"
              returnKeyType="default"
              spellCheck={false}
              style={styles.hiddenTerminalInput}
            />
            {!terminalFocused ? (
              <Pressable
                accessibilityRole="button"
                onPress={focusTerminalInput}
                style={styles.terminalTapTarget}
              />
            ) : null}
          </Pressable>

          <ScrollView
            horizontal
            style={styles.shortcutScroller}
            contentContainerStyle={styles.shortcutBar}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {TERMINAL_SHORTCUTS.map((shortcut) => (
              <Pressable
                key={shortcut.label}
                onPress={() => {
                  focusTerminalInput();
                  writeTerminalInput(shortcut.input);
                }}
                disabled={starting || !session?.active}
                style={({ pressed }) => [
                  styles.shortcutKey,
                  pressed && styles.shortcutKeyPressed,
                  (starting || !session?.active) && styles.shortcutKeyDisabled,
                ]}
              >
                <Text style={styles.shortcutKeyText}>{shortcut.label}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={focusTerminalInput}
              disabled={starting || !session?.active}
              style={({ pressed }) => [
                styles.keyboardKey,
                pressed && styles.shortcutKeyPressed,
                (starting || !session?.active) && styles.shortcutKeyDisabled,
              ]}
            >
              <Ionicons name="keypad-outline" size={15} color={theme.colors.textSecondary} />
            </Pressable>
          </ScrollView>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TerminalLine({
  cols,
  cursorX,
  isCursorRow,
  line,
  styles,
}: {
  cols: number;
  cursorX: number;
  isCursorRow: boolean;
  line: string;
  styles: ReturnType<typeof createStyles>;
}) {
  const paddedLine = line.padEnd(cols, ' ');
  if (!isCursorRow) {
    return (
      <Text style={styles.outputText} numberOfLines={1} ellipsizeMode="clip">
        {paddedLine}
      </Text>
    );
  }

  const normalizedCursorX = Math.max(0, Math.min(cursorX, Math.max(cols - 1, 0)));
  const beforeCursor = paddedLine.slice(0, normalizedCursorX);
  const cursorChar = paddedLine[normalizedCursorX] ?? ' ';
  const afterCursor = paddedLine.slice(normalizedCursorX + 1);

  return (
    <Text style={styles.outputText} numberOfLines={1} ellipsizeMode="clip">
      {beforeCursor}
      <Text style={styles.cursorCell}>{cursorChar}</Text>
      {afterCursor}
    </Text>
  );
}

function createEmptyTerminalFrame(cols: number, rows: number): TerminalFrame {
  return {
    cols,
    rows,
    cursorX: 0,
    cursorY: 0,
    lines: Array.from({ length: rows }, () => ''),
  };
}

function readTerminalFrame(terminal: HeadlessTerminalInstance): TerminalFrame {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const startRow = buffer.baseY;

  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(startRow + row);
    lines.push(line?.translateToString(false, 0, terminal.cols) ?? '');
  }

  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursorX: Math.max(0, Math.min(buffer.cursorX, Math.max(terminal.cols - 1, 0))),
    cursorY: Math.max(0, Math.min(buffer.cursorY, Math.max(terminal.rows - 1, 0))),
    lines,
  };
}

function decodeTerminalBase64Chunk(encoded: string, decoder: TextDecoder): string {
  const bytes = decodeBase64ToBytes(encoded);
  return decoder.decode(bytes, { stream: true });
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  const bufferLike = globalThis as typeof globalThis & {
    Buffer?: {
      from(input: string, encoding: string): { values(): IterableIterator<number> };
    };
  };
  if (bufferLike.Buffer) {
    return Uint8Array.from(bufferLike.Buffer.from(normalized, 'base64').values());
  }

  return new Uint8Array();
}

function concatTerminalBase64Chunks(chunks: string[]): string {
  const decodedChunks = chunks.map(decodeBase64ToBytes);
  const totalLength = decodedChunks.reduce((sum, bytes) => sum + bytes.length, 0);
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const bytes of decodedChunks) {
    joined.set(bytes, offset);
    offset += bytes.length;
  }

  return encodeBytesToBase64(joined);
}

function encodeTerminalInput(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBytesToBase64(bytes);
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary);
  }

  const bufferLike = globalThis as typeof globalThis & {
    Buffer?: {
      from(input: string, encoding: string): { toString(encoding: string): string };
    };
  };
  if (bufferLike.Buffer) {
    return bufferLike.Buffer.from(binary, 'binary').toString('base64');
  }

  throw new Error('Base64 encoding is unavailable in this runtime');
}

function getInitialRendererInfo(): TerminalRendererInfo {
  try {
    return normalizeRendererInfo(ClawdexTerminalModule.getRendererInfo());
  } catch {
    return {
      available: false,
      backend: 'unavailable',
      message: 'The native terminal renderer could not be loaded in this runtime.',
    };
  }
}

function normalizeRendererInfo(value: unknown): TerminalRendererInfo {
  const payload = (value ?? {}) as Partial<TerminalRendererInfo>;
  return {
    available: payload.available === true,
    backend: typeof payload.backend === 'string' ? payload.backend : 'unknown',
    message:
      typeof payload.message === 'string'
        ? payload.message
        : 'The native terminal renderer is unavailable.',
  };
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.isDark ? '#000000' : theme.colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.bgMain,
  },
  menuBtn: { padding: theme.spacing.xs },
  headerTitle: { ...theme.typography.headline, color: theme.colors.textPrimary },
  headerStatus: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  headerStatusText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  body: { flex: 1 },
  terminalWindow: {
    flex: 1,
    backgroundColor: '#050607',
    borderRadius: 0,
    borderWidth: 0,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  terminalViewport: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#050607',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  terminalViewportFocused: {
    borderColor: 'rgba(181, 189, 204, 0.58)',
  },
  terminalTapTarget: {
    ...StyleSheet.absoluteFillObject,
  },
  output: {
    flex: 1,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  nativeRenderer: {
    flex: 1,
    backgroundColor: '#050607',
  },
  outputText: {
    ...theme.typography.mono,
    color: '#F3F4F8',
    fontSize: 13,
    lineHeight: FALLBACK_CELL_HEIGHT,
    includeFontPadding: false,
  },
  cursorCell: {
    color: '#050607',
    backgroundColor: '#F3F4F8',
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
  hiddenTerminalInput: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    opacity: 0,
    color: 'transparent',
  },
  shortcutScroller: {
    flexGrow: 0,
    backgroundColor: '#0D0F12',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  shortcutBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
  },
  shortcutKey: {
    minWidth: 40,
    height: 28,
    borderRadius: 6,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: '#171A1F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardKey: {
    width: 34,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#171A1F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutKeyPressed: {
    backgroundColor: '#242832',
  },
  shortcutKeyDisabled: {
    opacity: 0.42,
  },
  shortcutKeyText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
});
