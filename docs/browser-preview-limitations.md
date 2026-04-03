# Browser Preview Limitations

The in-app browser is a local web preview tool for trusted/private development setups. It is not a
general-purpose remote browser.

## What it supports well

- Local web apps running on the bridge host, such as Next.js, Vite, CRA, static servers, and Expo
  Web
- Standard page loads, subresources, cookies, redirects, and WebSocket/HMR traffic
- Local multi-port full-stack development when the frontend reaches other local services through
  normal browser APIs or form posts:
  - `fetch`
  - `XMLHttpRequest`
  - `EventSource`
  - `WebSocket`
  - standard HTML form submission

## Current limitations

- Only loopback targets on the bridge host are supported: `localhost`, `127.0.0.1`, and `::1`
- The preview is meant for local dev servers, not arbitrary internet browsing through the bridge
- Native React Native or Expo native UI is not previewed directly; this feature only renders web
  content
- Browser runtime rewriting only applies to supported browser APIs and form posts. Hard-coded
  absolute localhost asset URLs outside those paths may still need a same-origin dev proxy in the
  app itself
- The shell is based on a mobile `WebView`, so it does not guarantee exact Safari or Chrome parity
  for every site feature
- Desktop mode is a viewport preset for responsive testing, not a full desktop browser engine

## Practical guidance

- Prefer relative API calls like `/api/*` when possible
- For split frontend/backend local stacks, make requests through supported browser APIs instead of
  embedding raw `localhost` URLs in places the runtime cannot rewrite
- If the app depends on exact browser-specific behavior, verify the final result in Safari or
  Chrome on the target device as well
