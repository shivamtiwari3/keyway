#!/bin/bash
# Build a distributable, double-click "Keyway.app".
#
# Produces a UNIVERSAL binary (arm64 + x86_64) and, when possible, a universal
# bundled Node runtime. Signing/notarization are opt-in via env vars:
#
#   CODESIGN_IDENTITY="Developer ID Application: You (TEAMID)"
#   APPLE_ID, TEAM_ID, APPLE_PASSWORD   (app-specific password)
#
# Without CODESIGN_IDENTITY the app is ad-hoc signed (Gatekeeper right-click).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$DIR/dist"
CACHE="$DIR/.cache"
APP="$DIST/Keyway.app"
BIN="$APP/Contents/MacOS/Keyway"
NODE_VER="${NODE_VERSION:-v22.11.0}"
MIN_MACOS="13.0"

rm -rf "$DIST"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$CACHE"

echo "compiling Swift UI (universal)..."
SWIFT_FLAGS=(-O -parse-as-library -framework SwiftUI -framework AppKit)
/usr/bin/swiftc "${SWIFT_FLAGS[@]}" -target "arm64-apple-macos$MIN_MACOS" -o "$CACHE/Keyway.arm64" "$DIR/app/main.swift"
if /usr/bin/swiftc "${SWIFT_FLAGS[@]}" -target "x86_64-apple-macos$MIN_MACOS" -o "$CACHE/Keyway.x64" "$DIR/app/main.swift" 2>/dev/null; then
  /usr/bin/lipo -create "$CACHE/Keyway.arm64" "$CACHE/Keyway.x64" -output "$BIN"
else
  echo "warn: x86_64 Swift build failed; arm64-only app"
  cp "$CACHE/Keyway.arm64" "$BIN"
fi

echo "bundling Node $NODE_VER (universal)..."
for arch in arm64 x64; do
  out="$CACHE/node-$arch"
  if [ ! -x "$out" ]; then
    if curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$arch.tar.gz" -o "$CACHE/node.tgz" \
       && tar -xzf "$CACHE/node.tgz" -C "$CACHE" "node-$NODE_VER-darwin-$arch/bin/node" \
       && mv "$CACHE/node-$NODE_VER-darwin-$arch/bin/node" "$out" && chmod +x "$out"; then
      :
    fi
  fi
done
if [ -x "$CACHE/node-arm64" ] && [ -x "$CACHE/node-x64" ]; then
  /usr/bin/lipo -create "$CACHE/node-arm64" "$CACHE/node-x64" -output "$APP/Contents/Resources/node"
else
  echo "warn: could not fetch both Node archs; bundling host node (single arch)"
  cp "$(command -v node)" "$APP/Contents/Resources/node"
fi
chmod +x "$APP/Contents/Resources/node"

cp "$DIR/setup.mjs" "$DIR/gateway.mjs" "$APP/Contents/Resources/"
cp "$DIR/app/Info.plist" "$APP/Contents/Info.plist"
/usr/bin/xattr -cr "$APP" 2>/dev/null || true

echo "signing..."
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  /usr/bin/codesign --force --deep --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$APP"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${TEAM_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ]; then
    echo "notarizing (this can take a few minutes)..."
    /usr/bin/ditto -c -k --keepParent "$APP" "$CACHE/notarize.zip"
    /usr/bin/xcrun notarytool submit "$CACHE/notarize.zip" \
      --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APPLE_PASSWORD" --wait
    /usr/bin/xcrun stapler staple "$APP"
  else
    echo "note: CODESIGN_IDENTITY set but APPLE_ID/TEAM_ID/APPLE_PASSWORD missing — skipping notarization"
  fi
else
  echo "note: ad-hoc signing (set CODESIGN_IDENTITY to sign for distribution)"
  /usr/bin/codesign --force --deep --sign - "$APP" 2>/dev/null || true
fi

(cd "$DIST" && /usr/bin/ditto -c -k --keepParent "Keyway.app" "Keyway-Setup.zip")
echo "built: $APP"
echo "zip:   $DIST/Keyway-Setup.zip"
/usr/bin/lipo -archs "$BIN" 2>/dev/null | sed 's/^/arch:  /'
du -sh "$APP" "$DIST/Keyway-Setup.zip"
