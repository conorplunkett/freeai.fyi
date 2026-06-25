#!/usr/bin/env bash
# Package the FreeAI Chrome extension into a clean, Web Store-ready .zip.
#
# Produces chrome-extension/dist/freeai-chrome-v<version>.zip containing ONLY
# the files the extension needs at runtime — an allowlist derived from
# manifest.json + popup.html — so no test/, node_modules/, package.json,
# README, or handoff notes ever leak into the upload.
#
# Usage:  make package-ext   (or run this script directly from anywhere)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/chrome-extension"
DIST="$EXT/dist"

cd "$EXT"

# Version is read straight from the manifest — the single source of truth.
VERSION="$(jq -r '.version' manifest.json)"
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "error: could not read .version from manifest.json" >&2
  exit 1
fi

# Exactly the runtime files. Everything manifest.json declares, plus the popup
# assets popup.html pulls in (it loads ../src/ads.js + popup.css + theme.css).
FILES=(
  manifest.json
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
  src/ads.js
  src/content.js
  src/background.js
  src/link.js
  src/inject.css
  popup/popup.html
  popup/popup.css
  popup/popup.js
  popup/theme.css
)

# Fail early if any expected file is missing.
missing=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "error: missing $f" >&2; missing=1; }
done

# Drift guard: every file the MANIFEST references (service worker, every
# content-script js/css, the popup, icons) MUST be in the package. The Web Store
# rejects a build whose manifest points at a file that isn't shipped — that's
# exactly how the src/link.js content script once leaked out of the zip. Derive
# the required set from manifest.json so the FILES allowlist can't silently
# drift from it again.
manifest_refs="$(jq -r '
  ([.background.service_worker]
   + ([.content_scripts[]?.js // []] | add // [])
   + ([.content_scripts[]?.css // []] | add // [])
   + [.action.default_popup]
   + [.icons[]?]
   + [.action.default_icon[]?])
  | map(select(. != null)) | unique | .[]
' manifest.json)"
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  case " ${FILES[*]} " in
    *" $ref "*) : ;;  # referenced by manifest AND packaged — good
    *) echo "error: manifest.json references '$ref' but it is not in the package allowlist (FILES)" >&2; missing=1 ;;
  esac
done <<< "$manifest_refs"

# Likewise, every LOCAL asset popup.html pulls in (theme.css, popup.css,
# ../src/ads.js, popup.js — http(s) links excluded) must ship too.
popup_refs="$(grep -oiE '(src|href)="[^"]*"' popup/popup.html \
  | sed -E 's/^(src|href)="//I; s/"$//' \
  | grep -viE '^(https?:)?//' || true)"
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  resolved="$(realpath -m --relative-to="$EXT" "popup/$ref")"  # popup.html lives in popup/
  case " ${FILES[*]} " in
    *" $resolved "*) : ;;
    *) echo "error: popup/popup.html references '$ref' ($resolved) but it is not in the package allowlist (FILES)" >&2; missing=1 ;;
  esac
done <<< "$popup_refs"

[ "$missing" -eq 0 ] || exit 1

# Guard the theme.css mirror discipline (AGENTS.md): the popup copy must be
# byte-identical to the repo-root source of truth, or the store build would
# ship a stale theme.
if ! cmp -s "$ROOT/web/theme.css" popup/theme.css; then
  echo "error: popup/theme.css is not byte-identical to web/theme.css" >&2
  echo "       fix with: cp web/theme.css chrome-extension/popup/theme.css" >&2
  exit 1
fi

# Syntax gate so a broken service worker never gets packaged.
npm run --silent lint >/dev/null

mkdir -p "$DIST"
OUT="$DIST/freeai-chrome-v$VERSION.zip"
rm -f "$OUT"
# -X drops extra file attributes for a reproducible, minimal archive.
zip -q -X "$OUT" "${FILES[@]}"

echo "Packaged FreeAI Chrome extension v$VERSION (${#FILES[@]} files, $(du -h "$OUT" | cut -f1))"
echo "  -> $OUT"
echo ""
printf '  %s\n' "${FILES[@]}"
echo ""
echo "Next: upload this .zip at https://chrome.google.com/webstore/devconsole"
echo "See chrome-extension/STORE_SUBMISSION.md for the full submission checklist."
