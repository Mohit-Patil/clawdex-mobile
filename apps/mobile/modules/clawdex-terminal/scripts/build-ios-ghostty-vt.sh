#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_ROOT="${MODULE_ROOT}/.build/ghostty-vt"
SOURCE_ROOT="${BUILD_ROOT}/source"
OUTPUT_ROOT="${MODULE_ROOT}/ios/vendor"
FRAMEWORK_PATH="${OUTPUT_ROOT}/ghostty-vt.xcframework"
GHOSTTY_REPO="${GHOSTTY_REPO:-https://github.com/ghostty-org/ghostty.git}"
GHOSTTY_REF="${GHOSTTY_REF:-2f1a30ddb047162a4d3acc20c2f83aadfcfe3fbb}"
REQUIRED_ZIG_VERSION="0.15.2"
ZIG_BIN="${GHOSTTY_ZIG_BIN:-}"

zig_version() {
  "$1" version 2>/dev/null || true
}

if [[ -z "${ZIG_BIN}" ]]; then
  for candidate in \
    "zig" \
    "/opt/homebrew/opt/zig@0.15/bin/zig" \
    "/usr/local/opt/zig@0.15/bin/zig" \
    "${HOME}/.local/bin/zig-0.15.2"; do
    if command -v "${candidate}" >/dev/null 2>&1 && [[ "$(zig_version "${candidate}")" == "${REQUIRED_ZIG_VERSION}" ]]; then
      ZIG_BIN="${candidate}"
      break
    fi
  done
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script expects macOS because Ghostty builds the Apple XCFramework with xcodebuild." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but was not found on PATH." >&2
  exit 1
fi

if ! command -v "${ZIG_BIN}" >/dev/null 2>&1; then
  echo "Zig ${REQUIRED_ZIG_VERSION} is required but was not found." >&2
  exit 1
fi

if [[ "$(zig_version "${ZIG_BIN}")" != "${REQUIRED_ZIG_VERSION}" ]]; then
  echo "Ghostty requires Zig ${REQUIRED_ZIG_VERSION}, but '${ZIG_BIN}' is $(zig_version "${ZIG_BIN}")." >&2
  echo "Install Homebrew zig@0.15 or pass GHOSTTY_ZIG_BIN=/path/to/zig-0.15.2." >&2
  exit 1
fi

mkdir -p "${BUILD_ROOT}" "${OUTPUT_ROOT}"
rm -rf "${SOURCE_ROOT}" "${FRAMEWORK_PATH}"

git init -q "${SOURCE_ROOT}"
git -C "${SOURCE_ROOT}" remote add origin "${GHOSTTY_REPO}"
git -C "${SOURCE_ROOT}" fetch --depth 1 origin "${GHOSTTY_REF}"
git -C "${SOURCE_ROOT}" checkout --detach FETCH_HEAD >/dev/null

(
  cd "${SOURCE_ROOT}"
  "${ZIG_BIN}" build -Demit-lib-vt
)

if [[ ! -d "${SOURCE_ROOT}/zig-out/lib/ghostty-vt.xcframework" ]]; then
  echo "Ghostty build finished but did not produce zig-out/lib/ghostty-vt.xcframework." >&2
  exit 1
fi

xcodebuild -create-xcframework \
  -library "${SOURCE_ROOT}/zig-out/lib/ghostty-vt.xcframework/ios-arm64/libghostty-vt-fat.a" \
  -headers "${SOURCE_ROOT}/zig-out/lib/ghostty-vt.xcframework/ios-arm64/Headers" \
  -library "${SOURCE_ROOT}/zig-out/lib/ghostty-vt.xcframework/ios-arm64-simulator/libghostty-vt-fat.a" \
  -headers "${SOURCE_ROOT}/zig-out/lib/ghostty-vt.xcframework/ios-arm64-simulator/Headers" \
  -output "${FRAMEWORK_PATH}"

echo "Vendored ghostty-vt.xcframework at:"
echo "  ${FRAMEWORK_PATH}"
