# AGENTS.md

Conventions for agents and contributors working in this repo.

## What FreeAI is

FreeAI shows one subtle sponsored line while a web AI assistant (ChatGPT, Claude,
Gemini) is thinking, and returns **50% of the revenue to the user as Claude
credits**. The product surface is a **Chrome extension**; a Node + Postgres
backend runs the ad auction, an append-only credit ledger, and gift-card
redemption.

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

## Theming

`theme.css` at the repo root is the single source of truth for color (Claude
coral on a cream canvas). The Chrome extension ships a **byte-identical** copy at
`chrome-extension/popup/theme.css` — keep the two in sync. Prefer the semantic
tokens (`--accent`, `--ink`, `--line`, …) for new styles.

## The landing page is live

`index.html` is the production public page. Keep it production-only: no test
mode, demo-mode messaging, mock seeds, or debugging affordances in user-facing
copy.

## Tests

- Extension: `cd chrome-extension && npm test` (headless mock DOM).
- Server: `cd server && npm test` — drives real routes against a real Postgres
  (`DATABASE_URL` required; `docker compose up -d db` for a local one).
