# Troubleshooting

## Onboarding looks stuck before Expo logs appear

- Expo startup can be slow on first launch.
- You should see: `Waiting for Expo output ...`
- Increase timeout if needed:

```bash
EXPO_OUTPUT_WAIT_SECS=180 clawdex init
```

- If Expo never emits logs:

```bash
tail -n 120 .expo.log
```

## Expo starts but QR/network is wrong

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

- Ensure `BRIDGE_AUTH_TOKEN` in `.env.secure` matches `EXPO_PUBLIC_HOST_BRIDGE_TOKEN` in `apps/mobile/.env`
- Restart bridge + Expo after token changes

## Tailscale issues

- Verify host and phone are on the same Tailscale network
- Check host IP (`tailscale ip -4`) and mobile `.env` URL

## `codex` not found

- Ensure `codex` is in `PATH`
- Or set `CODEX_CLI_BIN` explicitly

## Bridge build fails with `linker 'cc' not found`

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

- Restart Expo and reload app bundle
- Ensure bridge/mobile revisions match
- Run API test if needed:

```bash
npm run -w apps/mobile test -- --runInBand src/api/__tests__/client.test.ts
```

## Stop button does not interrupt a run

- Ensure revision supports `turn/interrupt`
- If run already finished, stop button disappears by design
- Pull latest, restart bridge, reload Expo bundle
