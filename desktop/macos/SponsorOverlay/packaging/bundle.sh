#!/usr/bin/env bash
# Wrap the SwiftPM executable into freeai.fyi.app, code-sign it, and produce
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

APP_NAME="SponsorOverlay"             # SwiftPM product: executable, zip + dmg names
PRODUCT_NAME="freeai.fyi"             # user-facing .app bundle name (Finder + Login Items)
VOL_NAME="FreeAI Sponsor Overlay"
VERSION="${VERSION:-0.1.0}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"   # default "-" = ad-hoc

BUILD_DIR="build"
# The bundle on disk is "freeai.fyi.app" so Finder + System Settings ▸ Login
# Items show "freeai.fyi", not the internal executable name. The executable
# inside stays "$APP_NAME" (matches CFBundleExecutable); the zip/dmg keep the
# "$APP_NAME" name so CI artifact paths are unchanged.
APP="$BUILD_DIR/$PRODUCT_NAME.app"
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

# SwiftPM resource bundle (the onboarding HTML/CSS/JS, declared in Package.swift).
# Copy it next to the app's other resources so Bundle.module (which checks
# Bundle.main.resourceURL) resolves it in the shipped app, as it does under
# `swift run`. Without this the Setup window falls back to the plain text sheet.
RES_BUNDLE=".build/release/${APP_NAME}_${APP_NAME}.bundle"
if [ -d "$RES_BUNDLE" ]; then
  cp -R "$RES_BUNDLE" "$RES_DIR/"
else
  echo "    WARNING: $RES_BUNDLE not found — onboarding assets won't be bundled" >&2
fi

echo "==> building AppIcon.icns from master"
ICON_MASTER="packaging/assets/AppIcon-1024.png"
ICONSET="$BUILD_DIR/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for sz in 16 32 128 256 512; do
  sips -z $sz $sz       "$ICON_MASTER" --out "$ICONSET/icon_${sz}x${sz}.png"      >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$ICON_MASTER" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES_DIR/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> embedding Sparkle.framework"
SPARKLE_FW=".build/release/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
  mkdir -p "$APP/Contents/Frameworks"
  cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/"
  # The SwiftPM executable resolves the framework via an rpath into the build
  # dir; add a bundle-relative rpath so the shipped app finds the embedded copy.
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/$APP_NAME" 2>/dev/null || true
else
  echo "    WARNING: $SPARKLE_FW not found — did 'swift build -c release' resolve Sparkle?" >&2
fi

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
# Fancy layout (background image + positioned icons) needs Finder scripting,
# which is unreliable headless — default on for local builds, off in CI.
DMG_FANCY="${DMG_FANCY:-1}"
DMG_STAGE="$BUILD_DIR/dmg"
DMG="$BUILD_DIR/$APP_NAME.dmg"
RW_DMG="$BUILD_DIR/$APP_NAME-rw.dmg"
rm -rf "$DMG_STAGE" "$DMG" "$RW_DMG"
mkdir -p "$DMG_STAGE/.background"
cp -R "$APP" "$DMG_STAGE/"
cp packaging/assets/dmg-background.png "$DMG_STAGE/.background/dmg-background.png"
ln -s /Applications "$DMG_STAGE/Applications"   # the drag target

build_plain_dmg() {
  hdiutil create -volname "$VOL_NAME" -srcfolder "$DMG_STAGE" \
    -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
}

build_fancy_dmg() {
  local dev
  hdiutil create -volname "$VOL_NAME" -srcfolder "$DMG_STAGE" \
    -fs HFS+ -format UDRW -ov "$RW_DMG" >/dev/null
  dev=$(hdiutil attach -readwrite -noverify -noautoopen "$RW_DMG" \
        | awk '/\/dev\// {print $1; exit}')
  osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOL_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 800, 520}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set background picture of opts to file ".background:dmg-background.png"
    set position of item "$PRODUCT_NAME.app" of container window to {165, 175}
    set position of item "Applications" of container window to {435, 175}
    update without registering applications
    delay 1
    close
  end tell
end tell
APPLESCRIPT
  sync
  hdiutil detach "$dev" >/dev/null
  hdiutil convert "$RW_DMG" -format UDZO -o "$DMG" >/dev/null
  rm -f "$RW_DMG"
}

made_dmg=0
if [ "$DMG_FANCY" = "1" ]; then
  if build_fancy_dmg; then
    made_dmg=1
  else
    echo "    (fancy layout failed — falling back to a plain dmg)"
    hdiutil detach "/Volumes/$VOL_NAME" >/dev/null 2>&1 || true
    rm -f "$RW_DMG" "$DMG"
  fi
fi
[ "$made_dmg" = "1" ] || build_plain_dmg
rm -rf "$DMG_STAGE"
if [ "$SIGN_IDENTITY" != "-" ]; then
  # Sign the container too, so Gatekeeper trusts the .dmg itself.
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi

echo "==> done"
echo "    $APP"
echo "    $BUILD_DIR/$APP_NAME.zip"
echo "    $DMG"
