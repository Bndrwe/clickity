#!/bin/sh
# Builds the macOS fn-key helper (native/macos/fnwatch.swift) as a universal binary at
# resources/mac/fnwatch. electron-builder copies it into Clickity.app/Contents/Resources.
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname)" != "Darwin" ]; then
  echo "build:fnwatch: macOS only, skipping" >&2
  exit 0
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p resources/mac
swiftc -O -target arm64-apple-macos12 native/macos/fnwatch.swift -o "$tmp/fnwatch-arm64"
swiftc -O -target x86_64-apple-macos12 native/macos/fnwatch.swift -o "$tmp/fnwatch-x64"
lipo -create "$tmp/fnwatch-arm64" "$tmp/fnwatch-x64" -output resources/mac/fnwatch
chmod +x resources/mac/fnwatch
codesign -s - -f resources/mac/fnwatch
echo "built resources/mac/fnwatch"
