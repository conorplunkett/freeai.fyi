# AGENTS.md

> **Agents must always read the instructions below before working on this repo.**

Conventions for agents and contributors working in this repo.

## Convenience commands

A root `Makefile` wraps the common local tasks — run `make` (or `make help`) for
the full self-documenting list. The day-to-day ones: `make server-up` (db +
migrate + API), `make site`, `make test-server`, `make test-ext`, `make test-mac`
(Rust core, any OS), `make mac-demo` / `make mac-run` / `make mac-bundle`, and
`make test` for everything. The per-component READMEs stay the source of truth;
when you change how something is built, run, or tested, update the matching
target's `## name: description` comment so `make help` stays accurate.

## What FreeAI is

FreeAI shows one subtle sponsored line while a web AI assistant (ChatGPT, Claude,
Gemini) is thinking, and returns **50% of the revenue to the user as Claude
credits**. The product surface is a **Chrome extension**; a Node + Postgres
backend runs the ad auction, an append-only credit ledger, and gift-card
redemption.

## Tech stack

- **Landing page + user portal** (`index.html`, `redeem.html`, `styles.css`,
  `theme.css`, `script.js`, `redeem.js`): plain static HTML/CSS/vanilla JS. No
  framework, no build step, no bundler. Served as static files.
- **Backend** (`server/`): Node.js (>= 20) on plain `node:http` — no web
  framework. One runtime dependency: `pg`. Dependency-injected for testing.
  Deployed on **Fly.io** (`server/fly.toml`).
- **Database**: **Postgres** — **Supabase** in production. Connected via a single
  `DATABASE_URL` (`server/src/boot.js`). Schema in `server/db/schema.sql`,
  applied with `npm run migrate`. The local `docker-compose.yml` is only a dev
  convenience; production is Supabase, not Docker.
- **Payments in**: **Stripe** Checkout (advertiser bids). Stripe Connect payout
  code exists but is parked in favor of gift-card credits.
- **Email**: pluggable mailer (`server/src/mailer.js`) — console transport in
  dev/CI, **Resend** in production.
- **Chrome extension** (`chrome-extension/`): Manifest V3, vanilla JS service
  worker + content script. Ships its own synced copy of `theme.css`.
- **macOS app** (`desktop/macos/`): Swift.
- **Tests**: Node's built-in runner conventions over `node:assert` — no test
  framework. Server tests run real routes against a real Postgres; extension
  tests run against a mock DOM.

## Where features live (read before adding UI)

- **Earning** happens in the **Chrome extension** (and the macOS app): they show
  ads and accrue credits.
- **Redeeming** credits for Claude gift cards happens **only on the website**
  (`freeai.fyi`), and **only after the user logs in**. The login is an email
  magic link; the redemption page reads the user's server-side balance and calls
  the backend, which emails the fulfillment inbox and deducts the balance.

  Do **not** add a redemption/gift-card menu to the Chrome extension popup or the
  macOS app. Redemption is a website-only, logged-in flow. Keep it that way.

## Money / credit rules

- The split is **50%** to the user, paid as **Claude credits** (not cash).
  Stripe Connect cash payouts exist in the code but are **parked** — gift cards
  are the redemption path. Don't surface Stripe payouts in user-facing copy.
- Credits live in an **append-only ledger** (`server/db/schema.sql`). Balances
  are always `SUM(ledger)`, never stored or edited. Amounts are integer
  **millicents** (1/1000¢) so the split is exact.
- A redemption: verifies `balance >= gift price`, emails the fulfillment inbox
  (`GIFT_FULFILLMENT_EMAIL`, default `conor.p43@gmail.com`) with the order
  details, then deducts the balance via a `gift_redemption_debit` ledger entry.
  Fulfillment is manual and lands within **48 hours**. Email goes out **before**
  the deduction; the in-transaction balance re-check keeps concurrent redeems
  honest.
- Redemption schedule lives in `server/src/giftcards.js` — the single source of
  truth for plans and prices. Update it there, not in the UI.

  | Redemption | Monthly | 1 mo | 3 mo | 6 mo | 12 mo |
  | --- | --- | --- | --- | --- | --- |
  | Claude Pro Gift | $20/mo | $20 | $60 | $120 | $240 |
  | Claude Max 5x Gift | $100/mo | $100 | $300 | $600 | $1,200 |
  | Claude Max 20x Gift | $200/mo | $200 | $600 | $1,200 | $2,400 |

## Design system

**`theme.css` at the repo root is the single source of truth for every color and
font in the project** — landing page, portal, Chrome extension (popup + injected
bar), and the macOS app. Always use it.

1. **Hard rule — never hardcode a color or font.** Do not write a raw hex/rgba
   value or a `font-family` stack anywhere (HTML/CSS/JS/Swift). Add or reuse a
   token in `theme.css`, then reference it: `var(--accent)`, `var(--ov-line)`,
   `var(--mono)` in CSS; the annotated `Palette` in Swift. The **only** exception
   is per-sponsor brand colors carried as ad inventory in
   `chrome-extension/src/ads.js` / `script.js` (a sponsor's own chip color) —
   that's content, not a design token.

2. **Two tokenized palettes.** The cream/coral **site palette** (`--accent`,
   `--ink`, `--line`, `--bg-cream`, …) and the dark **overlay/sponsor palette**
   (`--ov-*`) used by the subtle pill shown while an assistant is thinking. Fonts
   are tokens too: `--mono`, `--sans`.

3. **Three mirrors must move together.** The website and the extension popup read
   `theme.css` directly. Three places can't reach it at runtime and mirror its
   values — when you change a token, update all of them **in the same commit**:

   | Surface | How it consumes tokens |
   | --- | --- |
   | Landing page + portal | links `theme.css` directly → `var(--…)` |
   | Extension popup | `chrome-extension/popup/theme.css` — **byte-identical copy** of root `theme.css` (`cp theme.css chrome-extension/popup/theme.css`) |
   | Injected sponsor bar | `chrome-extension/src/inject.css` — re-declares the `--ov-*` + font tokens on `.bb-bar` (theme.css is **not** loaded on third-party pages like claude.ai), then uses `var(--…)` |
   | macOS overlay | `OverlayPanel.swift` `Palette` enum — each member tagged with its `--ov-*` token name |

   There is no build step or sync script (by design) — keeping the mirrors honest
   is a manual discipline, enforced by this doc.

4. **Sanctioned divergence.** The macOS overlay uses native
   `NSFont.monospacedSystemFont` rather than bundling JetBrains Mono — colors are
   unified, the font is intentionally native. Don't "fix" it.

5. **Next token group.** Radius/shadow values are still inline and not yet
   tokenized — when you first need to share one, add a `--radius-*` / `--shadow-*`
   group to `theme.css` rather than hardcoding it.

## The landing page is live

`index.html` is the production public page. Keep it production-only: no test
mode, demo-mode messaging, mock seeds, or debugging affordances in user-facing
copy.

## Tests

- Extension: `cd chrome-extension && npm test` (headless mock DOM).
- Server: `cd server && npm test` — drives real routes against a real Postgres
  (`DATABASE_URL` required; `docker compose up -d db` for a local one).
