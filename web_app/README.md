# Clawdex Demo Web App

This is a local full-stack demo for exercising the mobile browser preview.

- Frontend: Vite + React on `http://127.0.0.1:3002`
- Backend: Express API on `http://127.0.0.1:3003`

The frontend intentionally talks to the backend over a separate localhost origin so the bridge preview can verify multi-origin fetch, form submit, and SSE behavior.

## Run

```bash
cd web_app
npm run install:all
```

In separate terminals:

```bash
cd web_app
npm run dev:backend
```

```bash
cd web_app
npm run dev:frontend
```

## API

- `GET /health`
- `GET /api/landing`
- `GET /api/waitlist`
- `POST /api/waitlist`
- `GET /api/pulse` (SSE)
