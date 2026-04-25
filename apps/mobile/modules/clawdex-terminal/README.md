# Clawdex Terminal Module

This local Expo module is the native terminal surface for `clawdex-mobile`.

Current state:

- the Rust bridge PTY session transport is already wired from the app
- iOS can switch to a native `libghostty-vt` path when `ghostty-vt.xcframework` is vendored
- Android still uses a native placeholder view while the module API is stabilized

## iOS libghostty-vt setup

Build and vendor the Ghostty XCFramework:

```sh
./scripts/build-ios-ghostty-vt.sh
```

That script pins Ghostty to commit `2f1a30ddb047162a4d3acc20c2f83aadfcfe3fbb`, runs:

```sh
zig build -Demit-lib-vt
```

and copies the resulting `ghostty-vt.xcframework` into `ios/vendor/`.

Requirements:

- macOS
- `git`
- Zig `0.15.2` on `PATH`, Homebrew `zig@0.15`, or pass it via `GHOSTTY_ZIG_BIN`
- Xcode command line tools

Without the vendored framework, the module stays in stub mode and the app falls back to the text terminal screen.
