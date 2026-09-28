#!/bin/bash
# Build a distributable, double-click "Keyway.app" (native window, bundles Node).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$DIR/dist"
APP="$DIST/Keyway.app"
BIN="$APP/Contents/MacOS/Keyway"

rm -rf "$DIST"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "compiling Swift UI..."
/usr/bin/swiftc -O -parse-as-library -target arm64-apple-macos13.0 \
  -o "$BIN" "$DIR/app/main.swift" -framework SwiftUI -framework AppKit

cp "$DIR/setup.mjs" "$DIR/gateway.mjs" "$APP/Contents/Resources/"
cp "$(command -v node)" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"
cp "$DIR/app/Info.plist" "$APP/Contents/Info.plist"

/usr/bin/xattr -cr "$APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$APP" 2>/dev/null || true

(cd "$DIST" && /usr/bin/ditto -c -k --keepParent "Keyway.app" "Keyway-Setup.zip")
echo "built: $APP"
echo "zip:   $DIST/Keyway-Setup.zip"
du -sh "$APP" "$DIST/Keyway-Setup.zip"
