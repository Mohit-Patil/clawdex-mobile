import { registerWebModule, NativeModule } from 'expo';

import type {
  ClawdexTerminalModuleEvents,
  TerminalRendererInfo,
} from './ClawdexTerminal.types';

class ClawdexTerminalModule extends NativeModule<ClawdexTerminalModuleEvents> {
  getRendererInfo(): TerminalRendererInfo {
    return {
      available: false,
      backend: 'web-placeholder',
      message: 'The libghostty-vt renderer is only planned for the native app build.',
    };
  }
}

export default registerWebModule(ClawdexTerminalModule, 'ClawdexTerminalModule');
