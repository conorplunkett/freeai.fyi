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
| `terminal/` | Standalone Claude Code terminal client. Adds a reversible `claude` shell alias and uses Claude Code `statusLine` + temporary `--settings` files to serve ads only while the CLI is thinking. |
| `vscode-extension/` | **Incubating.** Modern VS Code / Cursor extension (Claude Code & Codex spinner ads). Builds & tests green; points at the API Edge Function; not yet wired to earn. See [`vscode-extension/INTEGRATION.md`](vscode-extension/INTEGRATION.md). |
| `legacy/vscode-extension/` | Archived. The original VS Code spinner extension — no longer the product. |

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
