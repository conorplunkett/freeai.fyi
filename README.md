# FreeAI.fyi

> Get **Claude** for free with ads while you use **ChatGPT, Claude, Gemini, and Claude Code**. **50%** of the revenue comes back as Claude credits.

FreeAI shows one subtle, clickable sponsored line while a web AI assistant or
Claude Code is thinking/streaming, and returns 50% of the revenue to you as
credits redeemable for Claude. The primary product is a **Chrome extension**,
with a standalone Claude Code terminal client; a Node + Postgres backend handles
the ad auction, an append-only ledger, and gift-card redemption.

## Repo layout

| Path | What |
| --- | --- |
| `chrome-extension/` | **Primary browser product.** MV3 extension for ChatGPT / Claude / Gemini. Load-unpacked instructions + Test mode in its README. |
| `supabase/functions/api/` | **Production API** (Supabase Edge Function, Deno) — ad auction, 50/50 ledger (millicents), Stripe Checkout, Claude gift-card redemption, referrals, earnings dashboard, killswitch. A full port of `server/`; replaced the Fly.io deploy. |
| `server/` | Original Node (`node:http`) implementation of the API — now the **tested reference + rollback** behind the Edge Function. |
| `index.html` · `styles.css` · `script.js` | Marketing site. Live by default (points at the API at `https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api`); append **`?dev=1`** to the URL for a sticky mock-data developer mode (`?dev=0` exits). |
| `landers/` | **Generated** per-audience landers — `developers`, `chatgpt`, `gemini`, `students`, `writers`, `researchers`, `founders`, `marketers`, `advertisers`, each served at a clean short URL (`/chatgpt`, …) via auto-managed `vercel.json` rewrites. Same page as `index.html` (the base/template) with audience-specific header copy, `<title>`/meta/canonical, and a before/after demo that mimics that audience's tool — e.g. ChatGPT's pulsing dot, styled in `landers/landers.css`. One URL per ad campaign. **Don't hand-edit** — change `index.html` (shared layout) or `tools/gen-landers.mjs` (per-audience copy/demo), then run `make landers` (also rewrites `vercel.json`). |
| `redeem.html` · `redeem.js` | **User portal.** Email magic-link / Google / Apple login → balance, earnings, activity, referrals, and the **only** gift-card redemption flow (a logged-in `POST /v1/web/redemptions`). |
| `admin.html` · `admin.js` | Static moderation + economics console; calls the admin-key API (campaign approve/reject, killswitch, referral/economics config). |
| `terminal/` | Standalone Claude Code terminal client. Adds a reversible `claude` shell alias and uses Claude Code `statusLine` + temporary `--settings` files to serve ads only while the CLI is thinking. |
| `desktop/` | **macOS app** (SponsorOverlay) — a menu-bar overlay that floats a sponsor card over Claude or ChatGPT Desktop while it generates. Pure-Rust `core/` decision logic (tested on any OS, 10 tests); Swift `macos/` shell. See [`desktop/README.md`](desktop/README.md). |

## Quick start

Run `make` (or `make help`) for a list of every convenience command with a
one-line description. The common ones:

| Command | What it does |
| --- | --- |
| `make site` | Serve the static site at http://localhost:8000 |
| `make server-up` | Start Postgres, migrate, and run the API on :8787 |
| `make server` | Start just the API (db already up) |
| `make test-server` | Server end-to-end tests against the local DB |
| `make test-ext` | Chrome extension headless tests |
| `make test-terminal` | Claude Code terminal client tests |
| `make test-mac` | Rust `overlay-core` tests (any OS) |
| `make mac-demo` | Run the macOS app in demo mode (no server/Claude) |
| `make mac-run` | Build & run the macOS app against the real API |
| `make mac-bundle` / `make mac-open` | Package then open `SponsorOverlay.app` |
| `make test` | Every test suite |

These wrap the per-component READMEs, which stay the source of truth:

- **Extension:** see [`chrome-extension/README.md`](chrome-extension/README.md).
  Load unpacked, flip on **Test mode**, open ChatGPT/Claude/Gemini → the mock ad
  shows immediately. `cd chrome-extension && npm test` runs the headless checks.
- **Terminal:** see [`terminal/README.md`](terminal/README.md).
  `freeai claude setup` installs a reversible shell alias/function so users keep
  typing `claude ...`; `freeai claude restore` removes it. `cd terminal &&
  npm test` runs the terminal client tests.
- **Backend:** see [`server/README.md`](server/README.md).
- **macOS app:** see [`desktop/README.md`](desktop/README.md).

## How it works

- A content script detects the "generating" state (a visible **Stop** button on
  ChatGPT/Claude/Gemini, an `aria-busy` region, or a streaming marker) and shows
  the sponsored bar only while the assistant is working.
- The terminal client detects Claude Code activity through the documented
  `statusLine` JSON input and Claude transcript metadata. It launches Claude
  with a temporary `--settings` file, never edits `~/.claude/settings.json`, and
  falls back to unchanged Claude when FreeAI cannot safely serve.
- Every 5 seconds served is one **impression**; a click is worth **50×**.
  Credits accrue at your **50%** share. **Test mode** shows a labelled mock ad
  continuously, with its own counters that never touch real earnings.
- It reads **none** of your prompts or the model's output. The terminal client
  reads only structural transcript metadata needed to tell active from idle.

---

*Not affiliated with Anthropic, OpenAI, or Google.*
