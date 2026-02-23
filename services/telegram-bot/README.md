# Telegram Bot Bridge

Telegram client for the Codex rust bridge (`services/rust-bridge`).

## What it does

- Maps each Telegram chat to one Codex thread.
- Forwards Telegram messages into `turn/start`.
- Streams `item/agentMessage/delta` updates back by editing a Telegram message.
- Surfaces `bridge/approval.requested` with inline approve/decline buttons.
- Handles `request_user_input` prompts via inline options or `/reply`.

## Security defaults

- Requires `BRIDGE_AUTH_TOKEN` unless `BRIDGE_ALLOW_INSECURE_NO_AUTH=true`.
- Requires `TELEGRAM_ALLOWED_CHAT_IDS` or `TELEGRAM_ALLOWED_USER_IDS`
  unless `TELEGRAM_ALLOW_UNRESTRICTED=true`.
- Keep bridge + bot on a trusted network and use least-privilege allowlists.

## Setup

1. Copy env template:

```bash
cp services/telegram-bot/.env.example services/telegram-bot/.env
```

2. Fill required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS` (recommended)
- `BRIDGE_AUTH_TOKEN`

3. Run bot:

```bash
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_ALLOWED_CHAT_IDS="<CHAT_ID>" \
BRIDGE_WS_URL="ws://127.0.0.1:8787/rpc" \
BRIDGE_AUTH_TOKEN="<BRIDGE_TOKEN>" \
npm run -w @codex/telegram-bot dev
```

## Supported Telegram commands

- `/help`
- `/new`
- `/thread`
- `/threads [limit]`
- `/use <number>`
- `/switch <thread_id>`
- `/approvals`
- `/apps`
- `/reply <request_id> <answer>`

## Notes

- State is persisted in `TELEGRAM_STATE_PATH` (default: `.telegram-bot-state.json`).
- Reply text is truncated to `TELEGRAM_MESSAGE_MAX_LENGTH` (default: 3900 chars).
- Set `TELEGRAM_MINI_APP_URL` (must be `https://`) to expose a Mini App button in `/apps` and Telegram menu.
- Optional label for the menu/app button: `TELEGRAM_MENU_BUTTON_TEXT`.
