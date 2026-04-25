import { requireNativeModule } from 'expo';
import type { NativeModule } from 'expo';

import {
  type ClawdexTerminalModuleEvents,
  type TerminalRendererInfo,
} from './ClawdexTerminal.types';

type ClawdexTerminalModuleType = NativeModule<ClawdexTerminalModuleEvents> & {
  getRendererInfo(): TerminalRendererInfo;
};

const FALLBACK_RENDERER_INFO: TerminalRendererInfo = {
  available: false,
  backend: 'unlinked',
  message: 'The native Clawdex terminal module is not linked in this runtime.',
};

let moduleInstance: ClawdexTerminalModuleType;

try {
  moduleInstance = requireNativeModule<ClawdexTerminalModuleType>('ClawdexTerminal');
} catch {
  moduleInstance = {
    getRendererInfo() {
      return FALLBACK_RENDERER_INFO;
    },
  } as ClawdexTerminalModuleType;
}

export default moduleInstance;
