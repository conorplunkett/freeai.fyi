# FreeAI.fyi

> Get **Claude** for free with ads while you use **ChatGPT, Claude, and Gemini**. **50%** of the revenue comes back as Claude credits.

FreeAI shows one subtle, clickable sponsored line while a web AI assistant is
thinking/streaming, and returns 50% of the revenue to you as credits redeemable
for Claude. The product is a **Chrome extension**; a Node + Postgres backend
handles the ad auction, an append-only ledger, and gift-card redemption.

## Repo layout

| Path | What |
| --- | --- |
| `chrome-extension/` | **The product.** MV3 extension for ChatGPT / Claude / Gemini. Load-unpacked instructions + Test mode in its README. |
| `server/` | Ad auction, 50/50 ledger (millicents), Stripe Checkout, Claude gift-card redemption, killswitch. |
| `index.html` · `styles.css` · `script.js` | Marketing site. |
| `legacy/vscode-extension/` | Archived. The original VS Code spinner extension — no longer the product. |

## Quick start

- **Extension:** see [`chrome-extension/README.md`](chrome-extension/README.md).
  Load unpacked, flip on **Test mode**, open ChatGPT/Claude/Gemini → the mock ad
  shows immediately. `cd chrome-extension && npm test` runs the headless checks.
- **Backend:** see [`server/README.md`](server/README.md).

## How it works

- A content script detects the "generating" state (a visible **Stop** button on
  ChatGPT/Claude/Gemini, an `aria-busy` region, or a streaming marker) and shows
  the sponsored bar only while the assistant is working.
- Every 5 seconds served is one **impression**; a click is worth **50×**.
  Credits accrue at your **50%** share. **Test mode** shows a labelled mock ad
  continuously, with its own counters that never touch real earnings.
- It reads **none** of your prompts or the model's output.

---

*Not affiliated with Anthropic, OpenAI, or Google.*
