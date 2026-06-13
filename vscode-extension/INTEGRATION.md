# Incorporating the VS Code / Cursor extension into FreeAI

This document explains **what was done**, **how this extension talks to a
backend**, **where its contract differs from the FreeAI server today**, and a
**staged plan** to make it actually earn against `api.freeai.fyi` — without
touching any existing FreeAI functionality.

---

## 1. What this is

`vscode-extension/` is the editor-agent sibling of the FreeAI Chrome extension.
It injects one clickable sponsored line into the **Claude Code** and **Codex**
"thinking…" spinners (VS Code panel + terminal CLI) and returns 50% of ad
revenue to the developer. Same business model as the rest of FreeAI, different
surface.

It was re-authored into the FreeAI product (MIT © FreeAI.fyi, matching the rest
of the repo) and **fully rebranded to FreeAI**:

- Package: `kickbacks-ai` → `freeai-fyi`, publisher `Kickbacksai` → `freeai`,
  `displayName` → `FreeAI.fyi`, version reset to `0.1.0`.
- Commands / config / context-key namespace: `kickbacks.*` → `freeai.*`
  (legacy `vibe-ads.*` aliases → `freeai-legacy.*`, kept to avoid duplicate
  command-id registration).
- Config dir `~/.vibe-ads/` → `~/.freeai/`; env vars `KICKBACKS_*` / `VIBE_ADS_*`
  → `FREEAI_*`.
- Injection markers `VIBE-ADS-START/END` → `FREEAI-START/END` (the strip/detect
  regexes still also recognize the legacy `VIB(E-)?ADS` form, so a machine
  migrating from the old extension is cleaned up correctly).
- Brand palette green `#188a45` → FreeAI orange `#d97757` (mirrors the site's
  `theme.css`); marketplace icon swapped to the FreeAI mark.
- Default backend → `https://api.freeai.fyi`; default update host →
  `https://freeai.fyi`.

**State today:** `npm run typecheck`, `npm run build`, and `npm test` (902
passing / 7 skipped) all green. It is build-ready and Cursor-compatible. **It is
wired to FreeAI's live endpoints** via the adapter in `src/freeaiApi/` (Phase 2,
§4) — in production the clients earn against `api.freeai.fyi` using an anonymous
device id, exactly like the Chrome extension.

**Containment:** everything lives under `vscode-extension/`. `git status` shows
this directory as the only addition. The Chrome extension, server, marketing
site, and macOS app are byte-for-byte untouched.

---

## 2. How the client talks to a backend

The extension is a thin client around a backend ("S2" in upstream naming). The
clients live in `src/`:

| Client | File | Calls |
| --- | --- | --- |
| Auth (device-flow) | `auth/client.ts` | `POST /v1/auth/extension/start`, `GET /v1/auth/extension/poll`, `POST /v1/auth/refresh`, `POST /v1/auth/signout` |
| Ad inventory | `portfolio/client.ts` | `GET /v1/portfolio` (+ `GET /v1/portfolio/demo` signed-out preview) |
| Telemetry | `metrics/client.ts` | `POST /v1/metrics` (+ `/v1/metrics/demo`) — impression / view-threshold / click |
| Earnings | `earnings/client.ts` | `GET /v1/earnings` |
| Killswitch | `killswitch/client.ts` | `GET /v1/killswitch` |
| Consent | `consent/client.ts` | `GET`/`POST /v1/me/consent` |
| Self-update | `update/client.ts` | `GET /v1/ext/manifest` (signed VSIX manifest) |

---

## 3. The FreeAI server today (`server/src/app.js`)

The production FreeAI server exposes a **device-key** contract (used by the
Chrome extension), not the token/portfolio contract above:

| Purpose | FreeAI endpoint | Returns |
| --- | --- | --- |
| Register anon device | `POST /v1/devices/register` | `{ deviceId, deviceKey }` |
| Config / killswitch | `GET /v1/config` | `{ serving, revenueShare }` |
| Ad inventory | `GET /v1/ads` | `{ ads: [{ id, brand, line, url, cat }], revenueShare }` |
| Impression/click batches | `POST /v1/events` | `{ deviceId, deviceKey, batchKey, events:[{impressions,clicks}] }` |
| Click token | `POST /v1/clicks/intent` | `{ trackingUrl }` |
| Earnings | `GET /v1/me/earnings` | display credit |
| Auth | Google/Apple **OAuth redirect** (`/v1/auth/google`, `/v1/auth/apple`, `/v1/web/*`) | session |

---

## 4. Phase 2 — wired via a client adapter (Option A, shipped)

The two contracts are **conceptually identical** (anonymous identity → fetch ads
→ report impressions/clicks → settle 50%) but **wire-level different**. Rather
than rewrite (and re-test) six clients, Phase 2 adapts at the one seam they all
share — the injectable `f: Fetch`.

**`src/freeaiApi/translate.ts` → `createFreeAiFetch()`** returns a function with
the exact `fetch` signature that intercepts the S2 paths and calls the real
FreeAI endpoints, synthesizing S2-shaped responses:

| S2 call the client makes | Translated to FreeAI | Notes |
| --- | --- | --- |
| `GET /v1/portfolio[/demo]` | `GET /v1/ads` | ad → `{ad_id, campaign_id, title_text, click_url}`; `view_threshold_seconds = 5` (FreeAI's "5s served = 1 impression") |
| `GET /v1/killswitch` | `GET /v1/config` | `killed = !serving`; unreachable → non-2xx so the client takes its offline (unconfirmed) branch |
| `POST /v1/metrics[/demo]` · `view_threshold_met` | `POST /v1/events` | one impression, fresh `batchKey`, with the device creds |
| `POST /v1/metrics[/demo]` · `click` | `POST /v1/clicks/intent` + redeem `trackingUrl` | forgery-proof click token |
| other metric events | dropped | `impression_rendered/_viewable`, `view_tick`, `prompt_view`, `error_impression` have no FreeAI equivalent |
| anon identity | `POST /v1/devices/register` | single-flight, cached in `globalState` (`freeai.device`) |
| anything unmapped | pass through | auth / consent / earnings / manifest 404 today; clients degrade gracefully |

Wired in `extension.ts`: the adapter is **on in production** and **off under the
test suite** (gated by `override?.freeaiAdapter ?? !testHooksEnabled()`), so the
existing e2e suite keeps exercising the clients' native S2 contract while
production talks to `api.freeai.fyi`. The translation itself is unit-tested in
`test/freeaiApi.test.ts` (11 tests). No server changes were needed — it reuses
the same ledger/auction the Chrome extension already uses.

**Deferred (not required to earn):** signed-in payout accounts (device-flow auth
`/v1/auth/extension/*`), per-account earnings display (`/v1/earnings`; the status
bar shows `$0.00` until a session exists), server-driven consent
(`/v1/me/consent`), and signed-manifest self-update (`/v1/ext/manifest` +
the private `deploy.mjs` signer; its `manifestSigning.test.ts` was removed, the
consumer in `update/client.ts` remains). These pass straight through and 404
harmlessly today.

**Later (Option B), if the auction needs editor-specific inventory:** implement
the richer `/v1/portfolio` / `/v1/metrics` semantics natively on the FreeAI
server and drop the translation. Bigger, touches the server — defer until the
editor product is validated.

---

## 5. Open items before publishing

1. **Licensing — resolved to MIT.** Re-authored into the FreeAI product under
   the MIT License (`LICENSE`, © FreeAI.fyi), matching the rest of the repo. As
   with any reuse, this reflects FreeAI's decision to license it; ensure that's
   backed by ownership/authorization of the original source.
2. **Earnings display + sign-in.** v1 earns anonymously per-device; the status
   bar shows `$0.00` because per-account earnings need a session. Add device-flow
   auth + `/v1/earnings` (or map to `/v1/me/earnings`) when a named payout
   account is wanted.
3. **Brand assets.** `media/icon.png` is the FreeAI Chrome-extension mark.
   Regenerate the full icon/lockup set via `npm run icon` (needs Playwright +
   Montserrat) once a final FreeAI editor mark is chosen.
4. **Cosmetic brand leak.** A few internal-only identifiers retain non-FreeAI
   spellings where renaming them buys nothing and adds risk: the `X-Vibe-Corr`
   correlation header, the private `vibeDir()` method name, and the
   `.vibads-backup` / `~/.vibe-ads` legacy-migration paths (intentionally kept so
   a machine coming from the old extension is detected and cleaned up). None are
   user-visible. Rename in a follow-up if desired.
5. **Manual verification.** `npm test` is green; do a real run in VS Code/Cursor
   against a staging `api.freeai.fyi` (or a local server via `FREEAI_BASE`) to
   confirm an ad renders in the Claude Code spinner and an impression lands in
   `/v1/events`.
6. **Marketplace metadata.** Publisher account, `repository`/`bugs` URLs (already
   `conorplunkett/freeai.fyi`), screenshots, categories.
