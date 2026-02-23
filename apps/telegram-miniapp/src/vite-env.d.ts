/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRIDGE_WS_URL?: string;
  readonly VITE_BRIDGE_AUTH_TOKEN?: string;
  readonly VITE_BRIDGE_ALLOW_QUERY_TOKEN_AUTH?: string;
  readonly VITE_BRIDGE_REQUEST_TIMEOUT_MS?: string;
  readonly VITE_DEFAULT_CWD?: string;
  readonly VITE_DEFAULT_MODEL?: string;
  readonly VITE_DEFAULT_EFFORT?: string;
  readonly VITE_DEVELOPER_INSTRUCTIONS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
