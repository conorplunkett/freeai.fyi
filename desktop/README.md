# FreeAI Desktop — Sponsor Overlay for Claude & ChatGPT Desktop (macOS)

Rough-out of the PRD: a menu bar companion app that floats a small sponsor
card over a supported AI desktop app — **Claude Desktop** or the **ChatGPT
(OpenAI) desktop app** — while it's generating, and credits the user for
qualified impressions. It never injects code into the app, never modifies its
files, and never reads prompts/responses.

Both apps are Electron/Chromium shells, so the same Accessibility-tree walk
drives detection for either; the small per-app differences (bundle id,
composer placeholder, whether the app shows a "thinking star") live in
`AssistantTarget` in `macos/SponsorOverlay/Sources/SponsorOverlay/AssistantDetector.swift`.
The overlay tracks whichever supported app is **frontmost**.

## Layout

| Path | What | Status |
|---|---|---|
| `core/` | `overlay-core` Rust crate — all decision logic: 5s continuous-visibility impression state machine, frequency caps + fraud throttles, campaign eligibility/selection, retry event queue, privacy-locked event schema | ✅ Built & tested here (`cargo test`, 10 tests) |
| `macos/SponsorOverlay/` | SwiftPM menu bar shell — Claude & ChatGPT detection via Accessibility API, non-activating overlay `NSPanel`, a 5-step WKWebView onboarding window, pause/quit menu | 🚧 Skeleton; build on a Mac with `swift build` |

## Architecture

The Swift shell is intentionally dumb: every 500ms it reads platform signals
(supported assistant focused? window bounds? thinking star or "Stop" button
present → generating? screen locked? overlay occluded?) and feeds them to the
core, which decides whether an impression qualifies and what events to queue.
The core is pure Rust with no platform deps, so all the money-adjacent rules
are unit-tested on any OS.

Between full polls, a 100ms fast-follow pass re-reads just the cached AX
frames of the window and the thinking star (two AX calls, no tree walk) and
re-anchors the card, so it visibly sticks to the star while the reply streams
or the transcript scrolls.

Planned wiring: build `overlay-core` as a staticlib (`crate-type` already set),
generate a C header with cbindgen, link from SwiftPM. Until then,
`ImpressionEngine.swift` is a faithful interim port of the tracker.

### Generation detection + anchoring (the risky bit)
1. **Primary:** one AX tree scan of the focused assistant window finds a "Stop"
   button (matched loosely on a button whose title/description/help contains
   the verb "stop" — "Stop response", "Stop generating", "Stop streaming") and,
   on Claude, the animated thinking star (matched by Chromium's `AXDOMClassList`
   attribute against the same `.epitaxy-spark-working` class the Chrome
   extension keys on). Either signal → generating.
   - **Claude:** the star's frame is what the card anchors to (composer, then
     window bottom, as fallbacks).
   - **ChatGPT:** there is no thinking star, so generation rests on the Stop
     button and the card anchors above the composer (then window bottom). The
     composer is the AXTextArea whose placeholder reads "Ask anything" /
     "Message ChatGPT".

   Structural attributes only — no message text read.
2. **Fallback (PRD):** assistant focused + recent user action, with conservative
   frequency caps.
3. **Last resort:** local-only visual heuristics behind Screen Recording
   permission. Not implemented; avoid if (1) holds up.

Bundle ids: Claude `com.anthropic.claudefordesktop`, ChatGPT `com.openai.chat`
— verify on a Mac with `osascript -e 'id of app "Claude"'` /
`osascript -e 'id of app "ChatGPT"'` before trusting detection. Per-app
selectors live in `AssistantTarget` (`AssistantDetector.swift`); adding a third
assistant is a new entry there.

## Privacy contract (enforced in code)

The event payload (`core/src/events.rs`) can only carry: user id, device id,
campaign id, event type, timestamp, visibility duration, coarse window state,
clicked flag. The struct uses `deny_unknown_fields` and a test asserts the
serialized key set exactly — adding a field that smuggles content fails CI.

## Impression rules implemented

- 5 *continuous* seconds visible; focus loss, lock, occlusion, pause,
  sign-out, display sleep, or a >2s tick gap (lid close) reset the clock.
- One impression per armed display; re-arms on campaign rotation/re-show.
- ≥60s between paid impressions of the same campaign (survives midnight).
- Daily per-campaign earnings cap (100¢ default), per-campaign daily
  frequency cap, budget check rounds impression cost *up*.
- Campaign hygiene: ≤60-char message, https-only destination URLs.

## Backend

The app speaks the **existing FreeAI API** (`server/`), the same protocol
as the other FreeAI clients: `POST /v1/devices/register` (anonymous device auth),
`GET /v1/ads`, `POST /v1/events` (idempotent batches keyed by `batchKey`),
`POST /v1/clicks/intent` (server-issued single-use click URLs, so clicks
can't be forged), `GET /v1/me/earnings`. Point the app elsewhere with
`FREEAI_API_URL`.

## Onboarding window

The Setup window (shown once on first launch, reopenable from the menu bar
**Setup** item) is the Claude Design handoff onboarding — a 5-step flow
(Welcome → How it works → Grant access → Save credits → All set). It's the
design's HTML/CSS/JS rendered in a `WKWebView`, living under
`Sources/SponsorOverlay/Resources/onboarding/`:

| File | What |
|---|---|
| `index.html` | entry point; loads the CSS + JS (no CDN — works offline) |
| `tokens.css` | DS tokens ported from the root `theme.css` color block (a mirror) |
| `onboarding.css` | the handoff's stylesheet verbatim + an embed override so `.win` fills the real window |
| `onboarding.js` | a vanilla-JS port of the handoff's `Onboarding.jsx` |

The web UI is wired to real app state through a JS↔Swift bridge
(`WKScriptMessageHandler`, see `showSetup()` in `main.swift`): "Open System
Settings" opens the Accessibility pane and the app **polls the live permission**
so the step flips to "Granted" the moment access is toggled on; "Launch at login"
registers/unregisters via `SMAppService`. Both Accessibility **and** launch-at-login
are required to advance past "Grant access", and each shows a matching Granted/
Enabled card. The sign-in step opens FreeAI's web sign-in in the browser; the rail
steps are clickable to revisit any completed step (their ✓ persists); and the final
"Open FreeAI" button closes the window and pops open the menu-bar item's menu.

`Package.swift` declares the directory as a resource; `swift run` finds it via
`Bundle.module` and `packaging/bundle.sh` copies the generated resource bundle
into the `.app`. To preview the design standalone in a browser (no native
bridge, so it falls back to the prototype's simulated permission grant):

```sh
cd desktop/macos/SponsorOverlay/Sources/SponsorOverlay/Resources/onboarding
python3 -m http.server 8000   # then open http://localhost:8000
```

## Testing

> **End-to-end across surfaces ("watch your balance climb"):** demo mode below
> logs to the console and never touches a real account. To earn against a local
> API and watch a portal balance update live, run the app with
> `FREEAI_API_URL=http://localhost:8787` and follow [`../DEVNET.md`](../DEVNET.md)
> (`make devnet` + `make devnet-earn`).

**Core logic (any OS):**
```sh
cd desktop/core && cargo test
```

**The app, on a Mac — demo mode (no server, no Claude needed):**
```sh
cd desktop/macos/SponsorOverlay
FREEAI_DEMO=1 swift run SponsorOverlay
```
Demo mode treats whatever window is frontmost as "Claude generating", shows a
seeded Linear card bottom-center, and logs qualified impressions/clicks to
the console after the 5-second timer. Watch with
`log stream --predicate 'eventMessage CONTAINS "freeai"'` or just the
terminal output.

**Probe mode — verify generation detection against your Claude/ChatGPT build:**
```sh
FREEAI_PROBE=1 swift run SponsorOverlay
```
Both apps are Electron, so their web contents are invisible to the AX API
until a client sets `AXManualAccessibility` — probe mode (and the real
detector) set it, then, for the **frontmost** supported assistant every 2s,
print a one-line verdict
`<Name> — generating=… stopButton=… composer=… star=<frame|n/a>` followed by
just the elements that matter for tuning: text inputs (composer candidates,
with their `placeholder=`), Stop buttons, and any star-like nodes. Focus Claude
or ChatGPT, start a generation, and watch the terminal: a "Stop …" button
appearing while streaming means detection works for either app; on Claude a
`class="…epitaxy-spark-working…"` element also appears and its frame is what the
card anchors to.

Set `FREEAI_PROBE_VERBOSE=1` to dump *every* labeled element/button instead
(use when nothing matches and you need the full tree). If Claude renames the
star class, the verbose dump shows the new star-like classes to put in
`isThinkingStar`; if ChatGPT renames its composer placeholder, the concise dump
shows the text input's `placeholder=` to add to `AssistantTarget.chatgpt.composerHints`.

**Window-tracking gates — manual checks (demo mode or real Claude):**
```sh
FREEAI_DEMO=1 swift run SponsorOverlay    # or plain `swift run` with Claude open
```
- *Minimized*: minimize the tracked window → card hides; restore → card returns.
- *Usable bounds*: shrink the window below 360×300 → card hides; enlarge → returns.
- *Move/resize dedupe*: drag or resize the window → card follows; once you stop,
  the panel frame is no longer reset on every 500ms tick.

**Against the real thing:**
```sh
swift run SponsorOverlay                  # uses FREEAI_API_URL or the default API
```
Grant Accessibility when prompted, open Claude or ChatGPT Desktop, start a
generation. The card should appear while the assistant streams; 5 visible
seconds → one impression batch lands in the server ledger; clicking routes
through `/v1/go/:token`, which records the click (clicks are tracked, not paid).

**CI** builds the Swift app on a `macos-14` runner on every push/PR, packages
it with `packaging/bundle.sh`, and uploads `SponsorOverlay.zip` + `.dmg` as the
`SponsorOverlay-macos` artifact. Download it from the Actions run, open the dmg
(or unzip), clear quarantine (`xattr -dr com.apple.quarantine freeai.fyi.app`),
and open. The CI build is **ad-hoc signed**, so it only runs on the machine that
built it (or after clearing quarantine) — a notarized build needs a Developer ID cert.

## Packaging & distribution

`packaging/bundle.sh` wraps the SwiftPM executable into `freeai.fyi.app` (the
user-facing name, so Finder + Login Items read "freeai.fyi"; the executable and
the zip/dmg keep the internal `SponsorOverlay` name), menu-bar-only via
`LSUIElement`, code-signs it, and produces both a `.zip` and a
drag-to-Applications `.dmg`:

```sh
cd desktop/macos/SponsorOverlay
./packaging/bundle.sh                  # ad-hoc signed, for local use
# -> build/freeai.fyi.app, build/SponsorOverlay.zip, build/SponsorOverlay.dmg
```

The app carries an icon (`AppIcon.icns`, built from `packaging/assets/AppIcon-1024.png`
via `iconutil`) and the dmg gets a laid-out install window (background + app/Applications
icons). The Finder layout needs a GUI session, so it's skipped headless — pass
`DMG_FANCY=0` to force the plain dmg (that's what CI does). Regenerate the icon
and dmg artwork with `python3 packaging/assets/generate_assets.py`.

### Shipping a notarized build people can download

The signed, **notarized** Developer ID dmg is the *only* build that opens on
someone else's Mac. The default `bundle.sh` (and the CI artifact) is ad-hoc
signed and runs **only on the machine that built it** — everywhere else
Gatekeeper says "damaged and can't be opened." A real release is four commands.

**One-time setup** (needs the **Apple Developer Program**, $99/yr):

1. A **Developer ID Application** certificate in your login keychain. Ours is
   `Developer ID Application: Conor Plunkett (C4GLRN98Q7)` (team id `C4GLRN98Q7`).
   Confirm it's installed with `security find-identity -v -p codesigning`.
2. Stash notary credentials in the Keychain so you never paste a password again —
   create an app-specific password at appleid.apple.com, then:
   ```sh
   xcrun notarytool store-credentials freeai \
     --apple-id "$APPLE_ID" --team-id "C4GLRN98Q7"
   ```

**Per release:**

```sh
cd desktop/macos/SponsorOverlay
# 1. build + sign with the Developer ID (hardened runtime, notarization-ready)
VERSION=0.1.0 BUILD_NUMBER=1 \
  SIGN_IDENTITY="Developer ID Application: Conor Plunkett (C4GLRN98Q7)" ./packaging/bundle.sh
# 2. notarize + staple (so it opens offline, no Gatekeeper prompt)
xcrun notarytool submit build/SponsorOverlay.dmg --keychain-profile freeai --wait
xcrun stapler staple build/SponsorOverlay.dmg
# 3. prove it'll open on a stranger's Mac — want "accepted" / "source=Notarized Developer ID"
spctl -a -t open --context context:primary-signature -v build/SponsorOverlay.dmg
# 4. publish — the asset filename MUST be FreeAI.dmg so /download/mac resolves.
#    (gh's "file#text" sets the display *label*, not the filename — the download
#    URL uses the filename — so upload a copy literally named FreeAI.dmg.)
cp build/SponsorOverlay.dmg build/FreeAI.dmg
gh release create desktop-v0.1.0 build/FreeAI.dmg \
  --title "FreeAI Desktop 0.1.0" \
  --notes "macOS FreeAI.fyi overlay tool for Claude & ChatGPT Desktop."
# Re-releasing the same tag? Don't `create` — upload over the existing asset:
#   gh release upload desktop-v0.1.0 build/FreeAI.dmg --clobber
```

**Hosting + the site link — no per-release site edit.** The dmg lives in
**GitHub Releases** (keeps the multi-MB binary out of git). `vercel.json`
redirects `/download/mac` → the repo's `releases/latest/download/FreeAI.dmg`, and
the **Download for macOS** button in `products.html` (the `#desktop` section)
points at `/download/mac`. So every `gh release create` automatically becomes the
live download — the button only 404s until the *first* release exists.

**Architecture:** `bundle.sh` builds **universal2 (arm64 + x86_64) by default**, so
one dmg runs on both Apple Silicon and Intel Macs (the script verifies the slices
with `lipo` and aborts if either is missing). Multi-arch products land in
`.build/apple/Products/Release/`, which the script accounts for. For a faster
host-arch-only bundle while iterating locally, set `UNIVERSAL=0`.

Distribute the stapled `.dmg` only. **Mac App Store is not a viable channel**:
sandboxed apps can't use the Accessibility API to read another app's window,
which is how generation detection works — Developer ID distribution is the path.

### Auto-update (Sparkle)

The app links [Sparkle](https://sparkle-project.org); `bundle.sh` embeds
`Sparkle.framework` into the app and adds the bundle-relative rpath. The menu
has a working **Check for Updates…** item; automatic background checks are off
in `Info.plist` until a real feed exists. To go live:

1. `generate_keys` (from Sparkle) once — keep the private key in your Keychain,
   put the printed public key in `Info.plist` as `SUPublicEDKey` (replacing the
   placeholder), and set `SUEnableAutomaticChecks` to `true`.
2. Host `appcast.xml` at the `SUFeedURL` (`https://freeai.fyi/appcast.xml`).
3. For each release, sign the zip/dmg with `sign_update` and add the resulting
   `<enclosure …>` entry to the appcast.

For Developer ID builds, Sparkle's nested helpers must be signed with the
hardened runtime; `bundle.sh`'s `codesign --deep --options runtime` covers
them, but verify with `codesign --verify --deep --strict` before notarizing.

## Still to do

1. Validate each app's real bundle id + whether its Electron AX tree exposes
   the Stop button (both apps), the thinking star's `AXDOMClassList` (Claude),
   and the composer placeholder (ChatGPT `composerHints`) — the riskiest
   assumptions. Run probe mode against both, see `AssistantDetector.swift`.
2. Keychain for device credentials (UserDefaults in the rough-out).
3. cbindgen FFI so the shell links `overlay-core` instead of the Swift port.
4. In-app magic-link sign-in. The onboarding's "Save credits" step currently
   opens FreeAI's web sign-in (`freeai.fyi/redeem`) in the browser; email verify
   exists server-side, so a native magic-link flow could replace the hop. Local
   frequency caps in the shell are also still TODO. App bundling + ad-hoc signing
   is done (`packaging/bundle.sh`); Developer ID signing + notarization still
   needs the paid Apple cert.
5. Redemption catalog UI (server currently pays out via Stripe Connect;
   PRD wants gift-card style redemptions too).
