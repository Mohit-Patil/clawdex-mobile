// Reexport the native module. On web, it will be resolved to ClawdexTerminalModule.web.ts
// and on native platforms to ClawdexTerminalModule.ts
export { default } from './src/ClawdexTerminalModule';
export { default as ClawdexTerminalView } from './src/ClawdexTerminalView';
export * from './src/ClawdexTerminal.types';
