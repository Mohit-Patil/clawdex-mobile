# Troubleshooting

## Bridge startup seems slow

- `clawdex init` no longer starts Expo for the shipped app.
- Published npm installs should use a bundled bridge binary on `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`.
- `clawdex init` should not run a repo `npm install` on the published CLI path.
- Published CLI installs should not pull Expo/React Native or ship the mobile source tree.
- If startup is still compiling Rust, you are usually on a source checkout, an unsupported host, or a package without bundled bridge binaries.
- The slow parts are usually npm dependency install/repair or the first Rust bridge build on source-based setups.
- If you want to skip the interactive wizard after initial setup, use `npm run secure:bridge`.

## Expo starts but QR/network is wrong

- This only applies when you are developing the mobile app locally from the repo.
- Re-run `npm run secure:setup`
- Confirm `.env.secure` has correct `BRIDGE_HOST`
- Restart `npm run mobile`

## Stop all running services quickly

Preferred:

```bash
clawdex stop
```

From repo checkout:

```bash
npm run stop:services
```

## Bridge auth errors (`401`, invalid token)

- For the shipped mobile app, rescan the bridge QR or update the stored token in Settings.
- For GitHub-auth Codespaces profiles, reopen `GitHub Codespaces` in the app and sign in with GitHub again if the GitHub App token or refresh token was revoked or expired.
- For a local dev build, also ensure `BRIDGE_AUTH_TOKEN` in `.env.secure` matches `EXPO_PUBLIC_HOST_BRIDGE_TOKEN` in `apps/mobile/.env`.
- Restart the bridge after token changes.
- On secure-launcher installs, `Settings > Bridge Maintenance > Restart bridge safely` can do that from the phone.
- If an in-app bridge update fails, inspect `.bridge-updater.log` and `.bridge-update-status.json` in the bridge install root.

## GitHub Codespaces bridge URL does not connect

- Pair to the printed forwarded HTTPS URL such as `https://<codespace>-8787.app.github.dev`, not `127.0.0.1`.
- Public forwarded ports reset back to private when the codespace restarts.
- Restart the bridge or rerun `npm run codespaces:bootstrap` to rerun the automatic visibility step.
- If needed, set both ports public manually:

```bash
gh codespace ports visibility 8787:public 8788:public
```

- If `gh` is unavailable in the codespace, use the Codespaces `Ports` panel and change both forwarded ports to `Public`.
- Keep bridge auth enabled. Public forwarded ports without bridge auth are not a safe setup.
- If GitHub direct sign-in is not showing in the app, confirm the build includes `EXPO_PUBLIC_GITHUB_APP_CLIENT_ID`, `EXPO_PUBLIC_GITHUB_APP_SLUG`, and `EXPO_PUBLIC_GITHUB_APP_AUTH_BASE_URL`.
- If the GitHub browser sheet returns but sign-in still fails, confirm the GitHub App callback URL is `https://<your-domain>/github/callback` and that `Request user authorization (OAuth) during installation` is enabled.
- If the app signs in but still cannot create a Codespace or clone/push inside it, reopen the GitHub App access step in the app and make sure the template repo and any target repos are selected for the installation.
- If in-app Codespace creation forks or targets the wrong repo, check `EXPO_PUBLIC_GITHUB_CODESPACES_REPO_NAME`, `EXPO_PUBLIC_GITHUB_CODESPACES_SOURCE_OWNER`, and `EXPO_PUBLIC_GITHUB_CODESPACES_REPO_REF` in the mobile build env.

## GitHub Codespaces bootstrap did not start the bridge

- Check the post-start command output in the Codespace terminal or rerun it manually:

```bash
npm run codespaces:bootstrap -- --prepare-only
npm run codespaces:bootstrap
```

- On the minimal `clawdex-codespace` template, rerun the packaged bootstrap instead:

```bash
CLAWDEX_WORKSPACE_ROOT="$PWD" node "$(npm root -g)/clawdex-mobile/scripts/codespaces-bootstrap.js" --prepare-only
CLAWDEX_WORKSPACE_ROOT="$PWD" node "$(npm root -g)/clawdex-mobile/scripts/codespaces-bootstrap.js"
```

- The Codespaces bootstrap only prepares the `codex` engine. It will try to install Codex automatically with `npm install -g @openai/codex`.
- `--prepare-only` installs Codex if needed and prebuilds the Rust bridge binary without starting the bridge.
- The bootstrap also enables `BRIDGE_GITHUB_CODESPACES_AUTH=true` so GitHub bearer tokens can connect directly to the bridge.
- If that install fails, fix npm/global package permissions in the codespace and rerun the bootstrap.
- Bridge startup logs and runtime state live in the Codespace repo root:

```bash
tail -n 200 .bridge.log
ls -la .bridge.pid .bridge.log .env.secure
```

- To only rewrite `.env.secure` without starting the bridge:

```bash
npm run codespaces:bootstrap -- --no-start
```

## Git push in a Codespace fails with `403` or permission denied

- The app now bootstraps GitHub HTTPS git credentials inside the Codespace after GitHub sign-in.
- If you signed in before this behavior shipped, reopen `GitHub Codespaces` in the app and sign in with GitHub once more so the saved token includes repository access.
- The bootstrap also rewrites common `git@github.com:...` and `ssh://git@github.com/...` remotes to HTTPS so they can use the same credential.
- After reconnecting, retry the clone/push from the app or from the Codespace shell.

## Voice transcription says no credentials were found

- The bridge can transcribe with either `OPENAI_API_KEY`, `BRIDGE_CHATGPT_ACCESS_TOKEN`, or the same ChatGPT auth tokens already used for Codex login.
- In GitHub Codespaces, finish the ChatGPT/Codex login step from the app first. The bridge will persist those tokens to `BRIDGE_WORKDIR/.clawdex-chatgpt-auth.json` and reuse them for voice transcription.
- If you still see the error after logging in, restart the bridge once so it reloads the persisted auth cache:

```bash
npm run secure:bridge
```

- You can inspect whether the bridge captured the token bundle:

```bash
ls -la .clawdex-chatgpt-auth.json
```

## Local browser preview does not open

- The in-app browser only supports loopback targets from the bridge host: `localhost`, `127.0.0.1`, or `::1`.
- Use entries like `localhost:3000`, `127.0.0.1:5173`, or just a port number.
- If a separate local API runs on another port, make sure the app reaches it through `fetch`, XHR, `EventSource`, `WebSocket`, or a normal form post so the preview runtime can rewrite it through the bridge.
- See `docs/browser-preview-limitations.md` for the current support boundaries and known caveats.
- If Browser reports preview is unavailable, check whether `BRIDGE_PREVIEW_PORT` is already in use on the host.
- By default the preview server binds to `BRIDGE_PORT + 1`.
- Restart the bridge after changing `BRIDGE_PREVIEW_PORT`.
- If the page shell loads but live reload does not, verify the target dev server is still serving its WebSocket/HMR endpoint locally.
- In GitHub Codespaces, the preview port (`8788` by default) must also be public or the Browser screen will fail even if the main bridge port works.

## Tailscale issues

- Verify host and phone are on the same Tailscale network
- Check host IP (`tailscale ip -4`) and the bridge URL saved in the mobile app

## `codex` not found

- Ensure `codex` is in `PATH`
- Or set `CODEX_CLI_BIN` explicitly

## Bridge build fails with `linker 'cc' not found`

This only applies when the bridge is building from Rust source instead of using a bundled binary.

Install C build tools:

```bash
sudo apt-get update && sudo apt-get install -y build-essential
```

Then retry `npm run secure:bridge`.

## iOS bundling error: `Unable to resolve "./BoundingDimensions"`

Manual recovery:

```bash
npm install --include=dev --force
npm install --include=dev --force -w apps/mobile
npm run -w apps/mobile start -- --clear
```

## Runtime errors: `[runtime not ready]` / `property is not writable`

Manual recovery:

```bash
rm -rf node_modules apps/mobile/node_modules
npm install --include=dev --force
npm install --include=dev --force -w apps/mobile
npm run -w apps/mobile start -- --clear
```

Also update Expo Go on your phone.

## Git operations fail

- Verify chat workspace is a valid git repo
- Verify remote auth/access for push

## Attachment upload issues

- Ensure mobile app has file/photo permissions
- File limit is `20 MB` per upload
- Uploads persist under `BRIDGE_WORKDIR/.clawdex-mobile-attachments`
- Ensure `BRIDGE_WORKDIR` is writable

## Worklets/Reanimated mismatch

```bash
cd apps/mobile
npx expo install --fix
npm run start -- --clear
```

## Plan mode errors (`RPC-32600` invalid `collaborationMode`)

- Restart the app and reconnect to the bridge
- Ensure bridge/mobile revisions match
- Run API test if needed:

```bash
npm run -w apps/mobile test -- --runInBand src/api/__tests__/client.test.ts
```

## Stop button does not interrupt a run

- Ensure revision supports `turn/interrupt`
- If run already finished, stop button disappears by design
- Pull latest, restart bridge, then retry from the mobile app
