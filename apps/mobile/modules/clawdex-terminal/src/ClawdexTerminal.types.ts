import type { StyleProp, ViewStyle } from 'react-native';

export type TerminalRendererInfo = {
  available: boolean;
  backend: string;
  message: string;
};

export type TerminalWriteFrame = {
  seq: number;
  dataBase64: string;
};

export type TerminalReadyEventPayload = TerminalRendererInfo & {
  sessionId?: string | null;
};

export type TerminalInputEventPayload = {
  sessionId?: string | null;
  dataBase64: string;
};

export type TerminalResizeEventPayload = {
  sessionId?: string | null;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
};

export type ClawdexTerminalModuleEvents = Record<string, never>;

export type ClawdexTerminalViewProps = {
  sessionId?: string | null;
  cols: number;
  rows: number;
  writeFrame?: TerminalWriteFrame | null;
  placeholderText?: string;
  onReady?: (event: { nativeEvent: TerminalReadyEventPayload }) => void;
  onInput?: (event: { nativeEvent: TerminalInputEventPayload }) => void;
  onTerminalResize?: (event: { nativeEvent: TerminalResizeEventPayload }) => void;
  style?: StyleProp<ViewStyle>;
};
