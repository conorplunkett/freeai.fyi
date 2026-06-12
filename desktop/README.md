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

## Run the tests

```sh
cd desktop/core && cargo test
```

## Next steps (mapped to PRD milestones)

1. **M1:** Supabase auth in the shell; permission onboarding flow UI;
   validate bundle id + AX tree against a real Claude Desktop build.
2. **M2:** cbindgen FFI so the shell uses `overlay-core` directly; campaign
   sync endpoint; "Why am I seeing this?" affordance.
3. **M3:** persisted queue file + flush loop; events API on the existing
   `server/` backend (it already has ledger/auction plumbing to reuse).
4. **M4/M5:** dashboard (balance/earnings/redemptions) and manual admin
   campaign tooling — likely extensions of the existing `server/` + site.
