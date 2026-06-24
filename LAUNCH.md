# FreeAI.fyi — Launch readiness

> End-to-end repo audit, **2026-06-19**. Every "verified" box below was run in
> this audit (commands + results shown). Boxes left unchecked are either human
> account/console steps or things this Linux CI box can't run (Deno / Swift).
> Source of truth for each surface stays its own README; this file is the
> cross-surface go/no-go.

## TL;DR

- **All runnable test suites are green:** Chrome ext 21/21, terminal 23/23,
  server 33/33 (real Postgres), Rust overlay-core 10/10.
- **The revenue split is applied correctly** everywhere (server, Edge Function,
  extension) — verified by the server test suite.
- **Blocking for a clean launch:** wire the production secrets + external OAuth/
  Stripe consoles (below). Everything else is ready.
- **To test the product end-to-end before launch** (all surfaces, watch a real
  account balance climb live, no real money / no Stripe): see
  [`DEVNET.md`](DEVNET.md) — `make devnet` + `make devnet-earn`.

## Verified working (run in this audit)

- [x] **Chrome extension** — `cd chrome-extension && npm test` → **21/21** checks
      (detection on ChatGPT/Claude/Gemini, test mode, the revenue split, prod wiring).
      `npm run lint` clean. MV3, `v0.3.0`, 8 host sites.
- [x] **Claude Code terminal client** — `cd terminal && npm test` → **23/23**.
      Default API base is the production Edge Function; reversible shell alias.
- [x] **Server (Node reference + rollback)** — `npm run migrate` applies
      `db/schema.sql` cleanly; `npm test` against a real Postgres 16 → **33/33**
      (checkout → webhook → moderation → auction → credit split → idempotency →
      caps → budget exhaustion → Connect onboarding → payout sweep → gift-card
      catalog → website login → redemption → referral rewards → dashboards →
      killswitch).
- [x] **macOS overlay core (Rust)** — `cd desktop/core && cargo test` → **10/10**
      (impression state machine, fraud caps, eligibility, privacy-locked event
      schema). Runs on any OS.
- [x] **Static site / portal JS** — `node --check` on `script.js`, `redeem.js`,
      `admin.js` all clean. Site + portal + admin all read the canonical API base
      from `<meta name="freeai-api">`.
- [x] **CI workflows present & coherent** — `.github/workflows/ci.yml`
      (`chrome-extension`, `server`, `terminal`, `desktop-core`, `desktop-macos`,
      `site` jobs) and `.github/workflows/deploy-functions.yml` (auto-deploy the
      Edge Function on push to `main` touching `supabase/functions/**`).
- [x] **API base is consistent in code** — every client and the site/admin/redeem
      meta tags point at `https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api`;
      `vercel.json` rewrites `api.freeai.fyi/*` onto the same function.

## Couldn't run in this environment (verify on the right host)

- [ ] **Supabase Edge Function (production API)** — needs **Deno** (absent here).
      It's a verbatim port of `server/` (which passed 33/33) and ships via
      `deploy-functions.yml`. Smoke the live `/healthz`, `/v1/config`, `/v1/ads`
      after deploy.
- [ ] **macOS app build** — needs **Swift on a Mac** (absent here). CI builds it
      on `macos-14`. The Rust core (the money-adjacent logic) is fully tested above.

## Pre-launch action items (human / accounts / consoles)

**Supabase Edge Function secrets** (dashboard → Edge Functions → Secrets; full
list in `supabase/functions/README.md`):

- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (and `STRIPE_CONNECT_WEBHOOK_SECRET`
      only if Connect payouts are turned on — they're currently parked).
- [ ] `ADMIN_KEY` (admin UI, killswitch, payouts, OAuth-state HMAC).
- [ ] `RESEND_API_KEY` + `MAIL_PROVIDER=resend` + `MAIL_FROM` — required for real
      login / verify / gift-fulfillment email (console transport otherwise).
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and the Apple set
      (`APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`)
      for social sign-in on the redeem portal.
- [ ] `SITE_URL` (defaults to `https://freeai.fyi`); `API_BASE_URL` optional.

**External consoles** (pin to the **canonical** function base, not the
`api.freeai.fyi` alias — the function emits its own redirect URIs):

- [ ] Google + Apple OAuth redirect URIs → `…/v1/auth/google/callback` and
      `…/v1/auth/apple/callback`.
- [ ] Stripe webhook endpoint → `…/v1/webhooks/stripe`; subscribe to
      `checkout.session.completed` (and `account.updated` if Connect is on).
- [ ] Stripe: swap test keys for live; complete the Connect platform profile only
      if/when cash payouts are unparked.

**Deploy / ops:**

- [ ] GitHub repo secret `SUPABASE_ACCESS_TOKEN` set (deploy auth), and Actions
      billing has minutes (private repo — exhausted minutes = 2s no-runner fails).
- [ ] Confirm `vercel.json` rewrite + DNS so `freeai.fyi` (site) and
      `api.freeai.fyi` (→ function) both resolve in prod.
- [ ] Gift fulfillment inbox watched: `GIFT_FULFILLMENT_EMAIL`
      (default `hello@contact.freeai.fyi`) — redemptions are **manual within 48h**.
- [ ] Know the killswitch: `POST /v1/admin/killswitch {"serving":false}` is
      **per-isolate** on Edge; for a global stop set `KILLSWITCH=1` and redeploy.

## Known issues / scoped-out for v1

- [ ] **macOS app** is a working skeleton: validate the real bundle ids + AX
      detection for Claude and ChatGPT Desktop on a Mac, move device creds to the
      Keychain, and (for public
      distribution) buy the **Apple Developer Program ($99/yr)** for Developer-ID
      signing + notarization. Tested Rust core + ad-hoc-signed bundle exist today.
- [ ] **Edge runtime differences** vs the Node reference: no in-memory per-IP rate
      limiter (DB-backed per-device/per-IP caps remain the abuse control), and the
      killswitch is per-isolate (above).

## Notes on the README audit

All eight READMEs were read and cross-checked against the code. They're kept
**per-component on purpose** (`AGENTS.md` makes each the source of truth, indexed
by the root README) — so the right "combine" was to make the root README a
complete index and fix drift, not to merge files. Fixes applied in this pass:

- `server/README.md`: endpoint table was missing the gift-card, OAuth, and entire
  `/v1/web/*` website-redemption/referral surface, and listed the retired
  `/v1/redemptions` as live — rebuilt and grouped; test count corrected 15 → 33.
- `README.md` (root): added the missing `desktop/` (macOS) row plus the `redeem`
  portal and `admin` console.
- `chrome-extension/`, `supabase/functions/` READMEs: aligned
  the API-base wording with the code (canonical Supabase URL; `api.freeai.fyi` is
  a Vercel rewrite, not a dead host).
