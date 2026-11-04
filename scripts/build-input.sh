#!/bin/sh
# Builds the macOS agent-mode input helper (native/macos/clickity-input.swift) as a universal,
# ad-hoc signed binary at resources/mac/clickity-input. electron-builder copies it into
# Clickity.app/Contents/Resources.
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname)" != "Darwin" ]; then
  echo "build:input: macOS only, skipping" >&2
  exit 0
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p resources/mac
swiftc -O -target arm64-apple-macos12 native/macos/clickity-input.swift -o "$tmp/clickity-input-arm64"
swiftc -O -target x86_64-apple-macos12 native/macos/clickity-input.swift -o "$tmp/clickity-input-x64"
lipo -create "$tmp/clickity-input-arm64" "$tmp/clickity-input-x64" -output resources/mac/clickity-input
chmod +x resources/mac/clickity-input
codesign -s - -f resources/mac/clickity-input
echo "built resources/mac/clickity-input"
