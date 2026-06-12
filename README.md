# FreeAI.fyi 🤑

> Make money while you use **ChatGPT, Claude, and Gemini**. You keep **90%**.

FreeAI shows one subtle, clickable sponsored line while a web AI assistant is
thinking/streaming, and pays you 90% of the revenue. The product is a **Chrome
extension**; a Node + Postgres backend handles the ad auction, an append-only
ledger, and Stripe payouts.

## Repo layout

| Path | What |
| --- | --- |
| `chrome-extension/` | **The product.** MV3 extension for ChatGPT / Claude / Gemini. Load-unpacked instructions + Test mode in its README. |
| `server/` | Ad auction, 90% ledger (millicents), Stripe Checkout + Connect payouts, killswitch. |
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
  Earnings accrue at your **90%** share. **Test mode** shows a labelled mock ad
  continuously, with its own counters that never touch real earnings.
- It reads **none** of your prompts or the model's output.

---

*Not affiliated with Anthropic, OpenAI, or Google.*
