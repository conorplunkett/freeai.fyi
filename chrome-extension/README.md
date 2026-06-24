# FreeAI.fyi — Chrome extension

> Earn money while you use AI. Ads appear while **ChatGPT, Claude & Gemini** think — a share of revenue goes to you.

While the assistant is thinking/streaming, FreeAI shows one subtle, clickable
sponsored line near the composer — and a share of the revenue becomes credits you
redeem for Claude. It reads none of your prompts or the model's output, only the
on/off "is it generating" state.

## Install & test it live (developer mode)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this `chrome-extension/` folder
4. Pin the FreeAI icon.

Then verify it two ways:

- **Test mode.** Click the toolbar icon → flip on **Test mode**. Open
  **chatgpt.com**, **claude.ai**, or **gemini.google.com**, ask anything, and a
  labelled **mock ad** (badged `TEST AD · mock`) appears while the model
  thinks, exactly where and how real ads will render. Mock impressions/clicks
  show in the popup and are *never* counted as real earnings.
- **Real flow.** Turn Test mode off, open one of those sites, and ask something.
  The sponsored line appears while the model streams its answer; earnings tick
  up in the popup. Or hit **"Show me the money"** for a 30-second demo on the
  active tab.

## How it works

- A content script watches the page for the "generating" signal — a visible
  **Stop** button (site-specific selectors for ChatGPT / Claude / Gemini, plus a
  generic `aria-label*="stop"` catch-all), an `aria-busy` region, or a streaming
  marker — and shows the sponsored bar only while the assistant is working.
- Every 5 seconds served is one **impression**; a click is worth more than an
  impression. Credits accrue at your revenue share, stored locally
  (`chrome.storage`), shown live in the popup.
- The bar mounts **inline, at the streaming reply** (Claude's
  `data-is-streaming` bubble, ChatGPT's last assistant turn, Gemini's
  `model-response`), falling back to a fixed pill above the composer only when
  no anchor is found.
- **Test mode** swaps in a labelled mock ad — shown under the same
  only-while-generating rule — and keeps its counts separate, so you can
  confirm rendering, placement, and click-through without real earnings.
- **Live backend.** `API_BASE` in `src/background.js` points at the production
  Supabase Edge Function
  (`https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api`; the
  `api.freeai.fyi` hostname is a Vercel rewrite onto the same function). On
  first run the service worker
  registers an anonymous device, pulls the live ad inventory from the auction
  (`/v1/ads`, falling back to the bundled list when offline), reports impressions
  to the ledger in idempotent batches (`/v1/events`), records clicks through
  single-use forgery-proof tokens (`/v1/clicks/intent`), and honours the server
  killswitch (`/v1/config`). Test-mode (mock) events never touch the network.

## Supported sites

`chatgpt.com` / `chat.openai.com` · `claude.ai` · `gemini.google.com`

Add more by editing `manifest.json` (`host_permissions` + `content_scripts.matches`).
Detection selectors live at the top of `src/content.js`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. |
| `src/ads.js` | Shared ad inventory + the Test-Mode mock ad. |
| `src/content.js` | Detects "generating", injects the sponsored bar, Test mode. |
| `src/inject.css` | Styling for the injected bar (incl. the test badge). |
| `src/background.js` | Service worker — earnings state, revenue math, test counters, and all prod backend calls (device register, live ads, event/click reporting). |
| `popup/*` | Earnings dashboard, enable + test toggles, demo, bid market. |
| `icons/*` | 16 / 48 / 128 px icons. |
| `test/run.js` | Headless harness (mock DOM + chrome) — `npm test`. |
| `test/live.js` | Live test — real Chrome + the unpacked extension via Puppeteer. |

## Tests

```bash
npm test           # detection on ChatGPT/Claude/Gemini, test mode, credit math (mock DOM)
npm run test:live  # loads the unpacked extension into headless Chrome (needs `npm install` first)
npm run lint
```

The live test stages a copy of the extension with `http://127.0.0.1/*` added to
its match patterns, serves a fake chat page locally, and verifies in a real
browser: injection, the Stop-button show/hide cycle, rendered ad copy, real
impressions hitting `chrome.storage` at the configured rate, and Test-Mode
impressions/clicks staying out of real earnings.

> **End-to-end across surfaces ("watch your balance climb"):** Test mode uses
> throwaway counters that never touch a real account. To earn against a local
> API and watch the portal balance update live, point the extension at the
> devnet by editing `API_BASE` in `src/background.js` to `http://localhost:8787`,
> reload unpacked, then follow [`../DEVNET.md`](../DEVNET.md) (`make devnet`).

## Publishing to the Chrome Web Store

```bash
make package-ext   # → chrome-extension/dist/freeai-chrome-v<version>.zip
```

Builds a clean, store-ready zip (only the 12 runtime files; refuses to build if
the popup `theme.css` mirror drifted or the JS fails lint). Full step-by-step —
listing copy, privacy/permission justifications, screenshot specs, and a
pre-submit checklist — is in [`STORE_SUBMISSION.md`](STORE_SUBMISSION.md).

## Settings

Stored in `chrome.storage.local` (defaults in `src/background.js`):
`enabled`, `testMode`, `revenueShare` (0.5), `grossCpm` (12), `blockedCategories`.

---

*Not affiliated with Anthropic, OpenAI, or Google.*
