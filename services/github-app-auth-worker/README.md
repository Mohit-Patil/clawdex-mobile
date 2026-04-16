# GitHub App Auth Worker

Tiny Cloudflare Worker for the GitHub Codespaces mobile flow.

Routes:

- `GET /github/callback`
  - renders a minimal page that bounces GitHub's callback back into `clawdex://github/callback`
- `POST /api/github/exchange`
  - exchanges the GitHub App authorization `code` for a user access token
- `POST /api/github/refresh`
  - refreshes a GitHub App user access token

Required secrets:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`

Optional vars:

- `GITHUB_APP_WEB_CALLBACK_URL`
  - exact GitHub callback URL if it differs from `https://<worker-domain>/github/callback`
- `GITHUB_APP_NATIVE_CALLBACK_URL`
  - defaults to `clawdex://github/callback`

Deploy:

```bash
cd services/github-app-auth-worker
npx wrangler secret put GITHUB_APP_CLIENT_ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler deploy
```

GitHub App settings should use:

- `Callback URL`: `https://<your-domain>/github/callback`
- `Request user authorization (OAuth) during installation`: enabled
