#!/usr/bin/env bash
# Wrap the SwiftPM executable into SponsorOverlay.app, code-sign it, and produce
# a drag-to-Applications .dmg (and a .zip) for distribution.
#
# Local use (no Apple Developer account needed) — ad-hoc signature, runs on the
# Mac that built it:
#   ./packaging/bundle.sh
#
# Distributable build — sign with your Developer ID (requires the $99/yr Apple
# Developer Program) so it runs the hardened runtime and can be notarized:
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./packaging/bundle.sh
#
# Then notarize + staple the .dmg (one-time setup of an app-specific password):
#   xcrun notarytool submit build/SponsorOverlay.dmg \
#     --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_PASSWORD" --wait
#   xcrun stapler staple build/SponsorOverlay.dmg
set -euo pipefail

cd "$(dirname "$0")/.."        # -> SponsorOverlay package root

APP_NAME="SponsorOverlay"
VOL_NAME="FreeAI Sponsor Overlay"
VERSION="${VERSION:-0.1.0}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"   # default "-" = ad-hoc

BUILD_DIR="build"
APP="$BUILD_DIR/$APP_NAME.app"
MACOS_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"

echo "==> swift build -c release"
swift build -c release
BIN=".build/release/$APP_NAME"

echo "==> assembling $APP (version $VERSION build $BUILD_NUMBER)"
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RES_DIR"
cp "$BIN" "$MACOS_DIR/$APP_NAME"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD_NUMBER/g" \
    packaging/Info.plist > "$APP/Contents/Info.plist"

echo "==> codesign (identity: $SIGN_IDENTITY)"
if [ "$SIGN_IDENTITY" = "-" ]; then
  # Ad-hoc: no timestamp, no hardened runtime (neither is valid without a cert).
  codesign --force --deep --sign - "$APP"
else
  # Developer ID: hardened runtime + secure timestamp, required for notarization.
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

echo "==> zipping (notarization-friendly)"
ditto -c -k --keepParent "$APP" "$BUILD_DIR/$APP_NAME.zip"

echo "==> building .dmg (drag-to-Applications)"
DMG_STAGE="$BUILD_DIR/dmg"
DMG="$BUILD_DIR/$APP_NAME.dmg"
rm -rf "$DMG_STAGE" "$DMG"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"   # the drag target
hdiutil create -volname "$VOL_NAME" -srcfolder "$DMG_STAGE" \
  -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$DMG_STAGE"
if [ "$SIGN_IDENTITY" != "-" ]; then
  # Sign the container too, so Gatekeeper trusts the .dmg itself.
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi

echo "==> done"
echo "    $APP"
echo "    $BUILD_DIR/$APP_NAME.zip"
echo "    $DMG"
