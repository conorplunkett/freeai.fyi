# DEVNET — local end-to-end testing & "mock money" mode

A turnkey way to run the **whole FreeAI stack locally** and watch a real account
balance climb in real time across surfaces — with **no real money and no Stripe
account**. This is the "devnet / mock money" mode.

Why it's safe to call it mock money: locally the ad budget comes from a **seeded
campaign** (not a paid advertiser), Stripe is **never called** (checkout is the
only Stripe path and it's disabled under `DEVNET=1`), and gift-card redemption is
a **manual** email step that you simply don't run. Credits accrue through the
exact same ledger code that runs in production — so what you see locally is the
real earning math, just funded by play money.

> Production readiness (secrets, OAuth/Stripe consoles) is tracked separately in
> [`LAUNCH.md`](LAUNCH.md). DEVNET is for **testing the product**, not for
> shipping it.

## TL;DR — watch your balance go up in 2 terminals

```bash
# Terminal 1 — boot db + migrate + seed a campaign + the API (no Stripe needed)
make devnet

# Terminal 2 — drive a real earning session and watch it climb live
make devnet-earn
```

`make devnet-earn` registers a device, links it to an account, serves
impressions on a loop, and prints a **portal sign-in link**. Open that link (or
sign in at `/redeem.html` with the printed email) and the dashboard balance ticks
up in lockstep as impressions accrue at the configured revenue share. A verified
click is worth more than an impression.

Knobs (env): `EARN_EMAIL`, `BATCH_IMPRESSIONS` (default 100), `TICK_MS`
(default 2000), `TICKS` (0 = run forever), `API_BASE`, `DATABASE_URL`.

## How the real-time loop works

Every surface does the same three things; `devnet-earn` simulates them so you can
see the whole chain without a browser:

1. `POST /v1/devices/register` → a device identity (anonymous).
2. `POST /v1/auth/request-link` + `GET /v1/auth/verify` → **links the device to
   an account** (this is the surface's "connect your email" step). Until a device
   is linked, its credits aren't visible in any portal.
3. `POST /v1/events` (impressions) and the single-use click-token path
   (`/v1/clicks/intent` → `/v1/go/:token`) → credits land in the append-only
   ledger at the configured revenue share.

The portal's `GET /v1/web/earnings` then sums the ledger across **every device
linked to that account**, so the same balance shows up no matter which surface
earned it.

> The magic-link/verify URLs are printed to the API console by the dev mailer
> (`[freeai][mail] … link=…`), so you can complete login flows locally with no
> mail provider.

## Testing each real surface against your local API

Point any surface at `http://localhost:8787`, link it to **the same email**, and
its earnings join the same portal balance.

| Surface | Point it at localhost | Link to an account |
| --- | --- | --- |
| **Simulator** | `API_BASE=http://localhost:8787` (default) | automatic |
| **Claude Code terminal** | `FREEAI_BASE=http://localhost:8787` | `freeai claude` then connect email in-app |
| **macOS app** | `FREEAI_API_URL=http://localhost:8787 make mac-run` | connect email in the menu-bar app |
| **Chrome extension** | edit `API_BASE` in `chrome-extension/src/background.js` to `http://localhost:8787`, reload unpacked | use the popup's connect-email flow |
| **Site / portal** | set `<meta name="freeai-api">` (or serve with the dev base) | sign in at `/redeem.html` |

Tip: the surfaces' built-in **Test mode / demo mode** (extension Test mode,
`make mac-demo`) deliberately use *throwaway counters that never touch the
ledger* — great for UI work, but they will **not** move your portal balance. Use
the real-serving path above (or `make devnet-earn`) when you want the account to
go up.

## What's covered vs. what still needs a real account

- ✅ Earning loop, ledger math, device→account linking, portal earnings/activity,
  referrals, the killswitch — all exercised locally and in `make test-server`
  (33 checks).
- ⚠️ **Advertiser checkout** needs Stripe **test** keys (`sk_test_…`) — it's
  disabled under `DEVNET=1`. To test it, set `STRIPE_SECRET_KEY` and run
  `stripe listen --forward-to localhost:8787/v1/webhooks/stripe`.
- ⚠️ **Google/Apple sign-in** needs OAuth client credentials + redirect URIs;
  the email magic-link path works with no setup.
- ⚠️ **Gift-card redemption** emails a fulfillment inbox and is fulfilled
  **manually** — locally the email just prints to the console.

See [`LAUNCH.md`](LAUNCH.md) for the full production cutover checklist.
