# FreeAI API — the credit loop

> **Production now runs as a Supabase Edge Function** (`supabase/functions/api/`),
> a full Deno port of this server, deployed on the same platform as the database.
> This `server/` tree is kept as the **tested reference + rollback** — its
> `npm test` suite still runs in CI and the Edge Function mirrors its routes and
> SQL verbatim. The Fly.io deploy was retired; references to Fly below are
> historical. See `supabase/functions/README.md`.

Node + Postgres backend that makes the 50/50 split real: a live ad auction,
an append-only ledger, Stripe Checkout for money **in**, and Claude gift-card
redemption for credits **out**.

```
  ADVERTISER                          DEVELOPER (VS Code extension)
      │                                        │
      │ POST /v1/checkout                      │ POST /v1/devices/register
      ▼                                        │ GET  /v1/ads  (auction-ranked)
  Stripe Checkout ──(webhook)──► campaign      │ POST /v1/events (batched, idempotent)
  pays $blocks×price            activated      ▼
                                     └──► LEDGER (millicents, append-only)
                                              50% → device   50% → platform
                                                    │
                                          POST /v1/admin/payouts (weekly sweep)
                                                    ▼
                                          Stripe Connect transfer → dev's bank
```

## Why these pieces

- **Postgres** is the source of truth. Balances are *never* stored — they're
  always `SUM(ledger)`, so the books can't drift. Amounts are integer
  **millicents** (1/1000¢) so the 50% of a half-cent impression is exact.
- **No framework** — plain `node:http`, one dependency (`pg`). The Stripe
  client is ~100 lines over `fetch`, because Stripe's API is just HTTPS +
  form-encoded bodies. Everything is dependency-injected, which is why the
  test suite can run the real routes against a real database with a fake
  Stripe transport.

## The Stripe APIs, concretely

### Money in — advertiser pays for blocks (Checkout)

1. `POST /v1/checkout` validates the bid (3–60 char ad line, https URL,
   ≥ $1/block), creates a `pending_payment` campaign, then calls
   **`POST https://api.stripe.com/v1/checkout/sessions`** with:
   - `mode=payment`, `line_items[0][quantity]=<blocks>`,
     `line_items[0][price_data][unit_amount]=<price_per_block_cents>`
   - `metadata[campaign_id]=<our id>` ← how the webhook finds the campaign
   - `success_url` / `cancel_url` back to the site
2. The advertiser pays on Stripe's hosted page. We never touch card data
   (no PCI scope).
3. Stripe fires **`checkout.session.completed`** at `POST /v1/webhooks/stripe`.
   We verify the `Stripe-Signature` header (HMAC-SHA256 of `"{t}.{rawBody}"`
   with the webhook secret, 5-minute tolerance, timing-safe compare), then
   activate the campaign: status → `active`, impressions funded
   (`blocks × 1000`), and a `campaign_credit` ledger entry.

### Money out — developer payouts (Connect Express)

Connect Express is the piece that keeps you out of the money-transmission
business: Stripe handles KYC, bank accounts, and tax forms (1099s).

1. `POST /v1/connect/onboard` links the device to a user (by email) and calls
   **`POST /v1/accounts`** with `type=express`,
   `capabilities[transfers][requested]=true`, then
   **`POST /v1/account_links`** with `type=account_onboarding` →
   returns a hosted onboarding URL where the developer enters identity + bank.
2. Stripe fires **`account.updated`** webhooks as onboarding progresses; we
   flip `users.payouts_enabled` when `charges_enabled && payouts_enabled`.
3. The payout sweep (`POST /v1/admin/payouts`, or `npm run payouts` on a cron)
   finds every enabled user at/over the threshold (default $10) and calls
   **`POST /v1/transfers`** with `amount=<whole cents>`, `currency=usd`,
   `destination=<acct_...>`. A `payout_debit` ledger entry + `payouts` row
   record it; sub-cent dust stays on the balance.

### Stripe setup checklist (test mode first)

1. Stripe Dashboard → enable **Connect**, choose **Express**.
2. Developers → API keys → copy `sk_test_...` → `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → add endpoint at your deployed
   `…/v1/webhooks/stripe` (production is the Edge Function base,
   `https://<ref>.supabase.co/functions/v1/api/v1/webhooks/stripe`), subscribe
   to `checkout.session.completed` and `account.updated` → copy the signing
   secret → `STRIPE_WEBHOOK_SECRET`.
   Locally: `stripe listen --forward-to localhost:8787/v1/webhooks/stripe`.
4. Test cards: `4242 4242 4242 4242`. Test Connect onboarding accepts fake
   SSN/bank values in test mode.
5. Going live: flip to live keys, fill out the Connect platform profile, and
   expect Stripe to review the platform (ads/revenue-share platforms are
   allowed; be accurate in the description).

## The fraud math (why the caps exist)

The moment dollars flow, idling a fake spinner 24/7 becomes a job. Defenses
built in:

- **Idempotent batches** — every `POST /v1/events` carries a unique
  `batchKey`; replays are acknowledged, never re-paid.
- **Daily device cap** — default 5,000 impressions/day (~7h of serving);
  excess batches get `429`.
- **Daily per-IP cap** — default 5,000 impressions/day per source IP (the same
  as one device's cap), so minting many free anonymous devices behind one host
  doesn't multiply the fraud ceiling. The IP is stored **hashed** (HMAC, never
  raw); the cap is fail-open and `IP_DAILY_IMPRESSION_CAP=0` disables it. Raise
  it (or disable) for operators with large shared-NAT / mobile-CGNAT audiences,
  where many genuine users share one IP.
- **Clicks are token-only** — `POST /v1/events` bills impressions *only*. A
  click bills 50x, so self-reported click counts (which would also dodge the
  impression cap) are never credited; genuine clicks earn solely through the
  single-use, forgery-proof token path (`/v1/clicks/intent` → `/v1/go`).
- **Daily click cap** — default 100 verified clicks/device/day; past it the
  `/v1/go` redirect still works but credits nothing, so the 50x path can't be
  looped to drain a budget.
- **Budget locks** — campaigns are row-locked on billing and can never be
  billed past `impressions_remaining`; they flip to `exhausted` atomically.
- **No double-spend on redeem** — concurrent gift redemptions serialize on a
  per-balance advisory lock, so the in-transaction balance check can't be raced
  into an overdraft.
- **Held payouts** — the $10 threshold + weekly sweep gives a review window.
- Next (not built): only count impressions while a real agent process is
  attached; device attestation / proof-of-work to price up bulk device minting.

## Run it

```bash
cd server
docker compose up -d db            # local Postgres 16
cp .env.example .env               # fill in Stripe test keys
npm install
npm run migrate                    # applies db/schema.sql
npm start                          # api on :8787
```

Smoke it:

```bash
curl localhost:8787/healthz
curl -X POST localhost:8787/v1/devices/register
curl -X POST localhost:8787/v1/checkout -H 'content-type: application/json' \
  -d '{"email":"ads@linear.app","adLine":"Linear — issue tracking built for speed","url":"https://linear.app/","pricePerBlock":5,"blocks":2}'
# -> { campaignId, checkoutUrl: "https://checkout.stripe.com/..." }
```

### Tests

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/freeai npm test
```

15 end-to-end checks drive the real routes against a real Postgres (isolated
schema per run) with only the Stripe transport faked: checkout → webhook
activation → auction ranking → 50% impression/click credits → idempotency →
caps → budget exhaustion → Connect onboarding → payout sweep.

## Wiring the extension

Point a client at this tree while it runs locally:

```json
{ "freeai.serverUrl": "http://localhost:8787" }
```

(Production clients point at the Edge Function base instead —
`https://<ref>.supabase.co/functions/v1/api`.) The extension then registers a
device, pulls auction-ranked ads from
`GET /v1/ads`, and batches impressions/clicks to `POST /v1/events` every 60s
(offline-safe: failed batches retry, and with no server it falls back to the
bundled demo inventory).

## Deploying

> Production no longer deploys from this tree. The live API is the Supabase
> Edge Function in `supabase/functions/api/` (a verbatim port); the site is on
> Vercel. This `server/` tree runs locally for the test suite and stands by as
> the rollback. See `supabase/functions/README.md` for the production deploy and
> secrets. The Fly.io / Neon / Cloudflare deploy this section once described was
> retired in the migration.

For the record, this Node process is a single, build-step-free server: point
`DATABASE_URL` at any Postgres, run the idempotent `npm run migrate`, then
`npm start`. The weekly payout sweep is `npm run payouts` (or `POST
/v1/admin/payouts` with the admin key).

## Campaign lifecycle

```
pending_payment ──(Stripe webhook: paid)──► pending_review ──(admin approve)──► active ──► exhausted
                                                  └──(admin reject)──► rejected (auto-refund)
```

Money is funded into the ledger at payment, but an ad **does not serve until a
human approves it** at `/admin` — which also keeps the listing marketplace-policy
clean. Rejection auto-refunds via Stripe and posts a reversing ledger entry.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | — | liveness |
| GET | `/v1/config` | — | serving flag (killswitch) + revenue share |
| GET | `/v1/ads` | — | auction-ranked active ads |
| GET | `/v1/leaderboard` | — | public bid market |
| POST | `/v1/devices/register` | — | mint device credentials |
| POST | `/v1/events` | device | batched impressions → ledger credits |
| POST | `/v1/clicks/intent` | device | mint a single-use click-tracking URL |
| GET | `/v1/go/:token` | token | record a verified click, 302 to the advertiser |
| POST | `/v1/checkout` | — | create campaign + Stripe Checkout URL |
| POST | `/v1/webhooks/stripe` | signature | payment + Connect events (deduped) |
| POST | `/v1/auth/request-link` | device | email a magic-link |
| GET | `/v1/auth/verify` | token | verify email, link device |
| POST | `/v1/connect/onboard` | device + verified | Stripe Express onboarding URL |
| GET | `/v1/me/earnings` | device | earned / paid out / balance |
| GET | `/v1/admin/campaigns` | admin key | moderation queue |
| POST | `/v1/admin/campaigns/approve` | admin key | approve → active |
| POST | `/v1/admin/campaigns/reject` | admin key | reject + refund |
| GET | `/admin` | admin key | minimal moderation UI |
| POST | `/v1/admin/payouts` | admin key | run the payout sweep |
| POST | `/v1/admin/killswitch` | admin key | `{ "serving": false }` halts all ad serving instantly |

## Hardening that's now built in

- **Server-side clicks** — clicks can't be forged by editing the ad URL. The
  extension requests an authenticated single-use token; the ad link is
  `/v1/go/:token`, which records the click once and 302s onward.
- **Email-gated payouts** — onboarding requires a verified email (magic-link,
  pluggable mailer; `console` transport in dev, Resend in prod).
- **Moderation** — paid campaigns wait in `pending_review` until approved at
  `/admin`; reject auto-refunds.
- **Exactly-once webhooks** — Stripe event ids are deduped, so retries can't
  double-fund or double-enable.
- **XSS-safe rendering** — advertiser text is intake-validated (no `< >`,
  3–60 printable chars) and escaped on every render path (site, `/admin`,
  extension webview).
- **Killswitch** — `POST /v1/admin/killswitch {"serving": false}` stops all ad
  serving instantly: extensions poll `GET /v1/config` every 5 minutes and go
  idle, and `/v1/ads` returns an empty list for older clients. Set
  `KILLSWITCH=1` to boot with serving off; the runtime toggle resets to the
  env default on restart.
- **Ops guards** — token-bucket rate limiting per IP, 64 KB request body cap,
  CORS locked to the site origin, structured request logging, graceful
  shutdown.

## CI

- **`.github/workflows/ci.yml`** — the `server` job spins up a Postgres 16
  service and runs these 15+ end-to-end API checks (`npm install` → `npm test`)
  on every push/PR. (Separate jobs cover the extension, terminal, desktop, and
  the site.)
- **Production deploy** is the Edge Function, not this tree:
  `.github/workflows/deploy-functions.yml`. The `Dockerfile` and `fly.toml` that
  once shipped this server were removed in the migration.

## What's still left for launch (your accounts)

- Real Stripe account + Connect enablement; swap test keys for live.
- Set `MAIL_PROVIDER=resend` + `RESEND_API_KEY` for real verification emails.
- Hosting/DNS and the production secrets now live with the Edge Function — see
  `supabase/functions/README.md` (the site is on Vercel under the `freeai.fyi`
  domain).
- Optional next: GitHub OAuth instead of email-only identity, per-IP device
  limits and click anomaly detection, edge WAF.
