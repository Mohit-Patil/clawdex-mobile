export const env = {
  macBridgeUrl:
    process.env.EXPO_PUBLIC_MAC_BRIDGE_URL?.replace(/\/$/, '') ??
    'http://127.0.0.1:8787'
};
