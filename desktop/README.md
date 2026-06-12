# FreeAI Desktop — Sponsor Overlay for Claude Desktop (macOS)

Rough-out of the PRD: a menu bar companion app that floats a small sponsor
card over Claude Desktop while it's generating, and credits the user for
qualified impressions. It never injects code into Claude, never modifies
Claude's files, and never reads prompts/responses.

## Layout

| Path | What | Status |
|---|---|---|
| `core/` | `overlay-core` Rust crate — all decision logic: 5s continuous-visibility impression state machine, frequency caps + fraud throttles, campaign eligibility/selection, retry event queue, privacy-locked event schema | ✅ Built & tested here (`cargo test`, 10 tests) |
| `macos/SponsorOverlay/` | SwiftPM menu bar shell — Claude detection via Accessibility API, non-activating overlay `NSPanel`, permission onboarding, pause/quit menu | 🚧 Skeleton; build on a Mac with `swift build` |

## Architecture

The Swift shell is intentionally dumb: every 500ms it reads platform signals
(Claude focused? window bounds? "Stop" button present → generating? screen
locked? overlay occluded?) and feeds them to the core, which decides whether
an impression qualifies and what events to queue. The core is pure Rust with
no platform deps, so all the money-adjacent rules are unit-tested on any OS.

Planned wiring: build `overlay-core` as a staticlib (`crate-type` already set),
generate a C header with cbindgen, link from SwiftPM. Until then,
`ImpressionEngine.swift` is a faithful interim port of the tracker.

### Generation detection (the risky bit)
1. **Primary:** AX tree scan of the focused Claude window for a
   "Stop response" button (structural attribute only — no message text read).
2. **Fallback (PRD):** Claude focused + recent user action, with conservative
   frequency caps.
3. **Last resort:** local-only visual heuristics behind Screen Recording
   permission. Not implemented; avoid if (1) holds up.

The bundle id is assumed to be `com.anthropic.claudefordesktop` — verify on a
Mac with `osascript -e 'id of app "Claude"'` before trusting detection.

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

The app speaks the **existing FreeAI API** (`server/`), same protocol as
the VS Code extension: `POST /v1/devices/register` (anonymous device auth),
`GET /v1/ads`, `POST /v1/events` (idempotent batches keyed by `batchKey`),
`POST /v1/clicks/intent` (server-issued single-use click URLs, so clicks
can't be forged), `GET /v1/me/earnings`. Point the app elsewhere with
`FREEAI_API_URL`.

## Testing

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

**Probe mode — verify generation detection against your Claude build:**
```sh
FREEAI_PROBE=1 swift run SponsorOverlay
```
Claude Desktop is Electron, so its web contents are invisible to the AX API
until a client sets `AXManualAccessibility` — probe mode (and the real
detector) set it, then dump every labeled element/button in Claude's focused
window every 2s plus a `generating=true/false` verdict. Focus Claude, start a
generation, and watch the terminal: a "Stop …" button appearing while
streaming means detection works.

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
Grant Accessibility when prompted, open Claude Desktop, start a generation.
The card should appear while Claude streams; 5 visible seconds → one
impression batch lands in the server ledger; clicking routes through
`/v1/go/:token` and credits the click.

**CI** builds the Swift app on a `macos-14` runner on every push/PR and
uploads the release binary as the `SponsorOverlay-macos` artifact —
download it from the Actions run, `chmod +x`, clear quarantine
(`xattr -d com.apple.quarantine SponsorOverlay`), and run.

## Still to do

1. Validate Claude's real bundle id + whether its Electron AX tree exposes
   the Stop button (the riskiest assumption — see ClaudeDetector.swift).
2. Keychain for device credentials (UserDefaults in the rough-out).
3. cbindgen FFI so the shell links `overlay-core` instead of the Swift port.
4. Real sign-in (email verify exists server-side), local frequency caps in
   the shell, app bundle + code signing + notarization for distribution.
5. Redemption catalog UI (server currently pays out via Stripe Connect;
   PRD wants gift-card style redemptions too).
