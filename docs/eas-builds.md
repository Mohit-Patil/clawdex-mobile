# EAS Builds and Distribution

Use this guide for standalone app builds/distribution.

## Where To Run EAS Commands

Run EAS commands from `apps/mobile`.

Why:

- Expo app config is in `apps/mobile/app.json`
- EAS config is in `apps/mobile/eas.json`

```bash
cd apps/mobile
```

You can also run from repo root with workspace scoping:

```bash
npm exec --workspace apps/mobile -- eas <command>
```

## Prerequisites

- `eas-cli` installed (`npm install -g eas-cli`)
- Logged in (`eas login`)
- Expo project linked (`eas project:info`)

## Build Profiles

Current profiles in `apps/mobile/eas.json`:

- `development` (dev client, internal distribution)
- `preview` (internal distribution)
- `production` (store/prod, auto-increment)

## Common Build Commands

From `apps/mobile`:

```bash
# Internal/dev-client builds
eas build --platform ios --profile development
eas build --platform android --profile development

# Internal preview builds
eas build --platform ios --profile preview
eas build --platform android --profile preview

# Production builds
eas build --platform ios --profile production
eas build --platform android --profile production

# Both platforms
eas build --platform all --profile preview
```

Track builds:

```bash
eas build:list --limit 10
eas build:view <BUILD_ID>
```

## Submit To Stores

```bash
eas submit --platform ios --latest --profile production
eas submit --platform android --latest --profile production
```

## Local Native Build Option (No EAS Cloud)

If you want local native builds instead:

```bash
npx expo run:ios
npx expo run:android
```

For iOS local device/signed builds, Apple signing/tooling is still required.

## iOS Distribution Reality

Without a public App Store release, iOS distribution still requires Apple provisioning paths:

1. Internal/dev provisioning with device allowlist
2. TestFlight private testing

Cloud builds are possible without public App Store listing, but signing/provisioning requirements still apply.
