# Betterbacks.ai — Chrome extension 🤑

> Get paid for waiting — in the browser. **You keep 90%.**

The VS Code extension monetizes the spinner in Claude Code & Codex. This is the same
idea for **web-based agents**: claude.ai, ChatGPT/Codex web, Gemini, Perplexity,
v0, bolt.new. While the assistant is thinking/streaming, Betterbacks shows one
subtle, clickable sponsored line — and pays you 90% of the revenue.

## Install (developer mode)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this `chrome-extension/` folder
4. Pin the Betterbacks icon, then open **claude.ai** or **chatgpt.com** and ask
   something. The sponsored line appears while it thinks.

Prefer a quick look? Click the toolbar icon → **"Show me the money"** to run a 30s
demo on the active tab.

## How it works

- A content script watches the page for the universal "generating" signals — a
  visible **Stop** button, an `aria-busy` region, or a streaming marker — and shows
  the sponsored bar only while the assistant is actually working.
- Every 5 seconds served is one **impression**. A click is worth **50×** an
  impression. Earnings accrue at your **90%** revenue share and are stored locally
  (`chrome.storage`), shown live in the popup.
- It reads **none** of your prompts or the model's output — only the on/off
  "is it generating" state and aggregate counts.

## Supported sites

`claude.ai` · `chatgpt.com` / `chat.openai.com` · `gemini.google.com` ·
`aistudio.google.com` · `perplexity.ai` · `v0.dev` · `bolt.new`

Add more by editing `manifest.json` (`host_permissions` + `content_scripts.matches`).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. |
| `src/ads.js` | Shared ad inventory (the bid market). |
| `src/content.js` | Detects "thinking", injects the sponsored bar. |
| `src/inject.css` | Styling for the injected bar. |
| `src/background.js` | Service worker — earnings state & revenue math. |
| `popup/*` | Earnings dashboard, toggle, demo, bid market. |
| `icons/*` | 16 / 48 / 128 px icons. |

## Settings

Stored in `chrome.storage.local` (defaults in `src/background.js`):
`enabled`, `revenueShare` (0.9), `grossCpm` (12), `blockedCategories`.

---

*Not affiliated with Anthropic, OpenAI, or Google.*
