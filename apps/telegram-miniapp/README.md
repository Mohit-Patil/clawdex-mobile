# Telegram Mini App

Web mini app for Codex thread/chat UX inside Telegram.

## MVP scope

- View recent threads
- Switch active thread
- Send prompts to selected thread
- See streaming assistant deltas in chat
- Stop active turn

## Setup

1. Copy env:

```bash
cp apps/telegram-miniapp/.env.example apps/telegram-miniapp/.env
```

2. Set bridge config in `apps/telegram-miniapp/.env`:

- `VITE_BRIDGE_WS_URL`
- `VITE_BRIDGE_AUTH_TOKEN` (optional if bridge allows insecure no-auth)
- `VITE_BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true` when token is used

3. Run locally:

```bash
npm run -w @codex/telegram-miniapp dev
```

## Mini App usage with Telegram bot

1. Host built app on HTTPS URL.
2. Set bot env:

```env
TELEGRAM_MINI_APP_URL=https://<your-miniapp-url>
TELEGRAM_MENU_BUTTON_TEXT=Open App
```

3. Restart Telegram bot.

Then use `/apps` or the Telegram menu button to open the mini app.

## Security note

This app runs in browser context; bridge auth token is exposed to the client if you set `VITE_BRIDGE_AUTH_TOKEN`. Keep deployment private/trusted and prefer short-lived tokens or a backend proxy for stronger isolation.
