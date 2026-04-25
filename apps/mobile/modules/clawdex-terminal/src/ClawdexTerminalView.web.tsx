import * as React from 'react';

import type { ClawdexTerminalViewProps } from './ClawdexTerminal.types';

export default function ClawdexTerminalView(props: ClawdexTerminalViewProps) {
  return (
    <div
      style={{
        alignItems: 'center',
        background: '#101114',
        borderRadius: 12,
        color: '#d1d5db',
        display: 'flex',
        fontFamily:
          'ui-monospace, SFMono-Regular, SF Mono, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        justifyContent: 'center',
        minHeight: 240,
        padding: 16,
        textAlign: 'center',
      }}
    >
      {props.placeholderText ?? 'The native Ghostty renderer is not available on web.'}
    </div>
  );
}
