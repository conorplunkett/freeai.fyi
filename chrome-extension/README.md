# FreeAI.fyi — Chrome extension 🤑

> Make money while you use **ChatGPT, Claude, and Gemini**. You keep **90%**.

While the assistant is thinking/streaming, FreeAI shows one subtle, clickable
sponsored line near the composer — and pays you 90% of the revenue. It reads
none of your prompts or the model's output, only the on/off "is it generating"
state.

## Install & test it live (developer mode)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this `chrome-extension/` folder
4. Pin the FreeAI icon.

Then verify it two ways:

- **Test mode (instant, no waiting).** Click the toolbar icon → flip on
  **Test mode**. Open (or reload) **chatgpt.com**, **claude.ai**, or
  **gemini.google.com** and a green-bordered **mock ad** appears immediately —
  this is exactly what real ads will look like. Mock impressions/clicks show in
  the popup and are *never* counted as real earnings.
- **Real flow.** Turn Test mode off, open one of those sites, and ask something.
  The sponsored line appears while the model streams its answer; earnings tick
  up in the popup. Or hit **"Show me the money"** for a 30-second demo on the
  active tab.

## How it works

- A content script watches the page for the "generating" signal — a visible
  **Stop** button (site-specific selectors for ChatGPT / Claude / Gemini, plus a
  generic `aria-label*="stop"` catch-all), an `aria-busy` region, or a streaming
  marker — and shows the sponsored bar only while the assistant is working.
- Every 5 seconds served is one **impression**; a click is worth **50×** an
  impression. Earnings accrue at your **90%** revenue share, stored locally
  (`chrome.storage`), shown live in the popup.
- **Test mode** shows a labelled mock ad continuously and keeps its counts
  separate, so you can confirm rendering, placement, and click-through on any
  supported page without generating anything.

## Supported sites

`chatgpt.com` / `chat.openai.com` · `claude.ai` · `gemini.google.com` ·
`aistudio.google.com` · `perplexity.ai` · `v0.dev` · `bolt.new`

Add more by editing `manifest.json` (`host_permissions` + `content_scripts.matches`).
Detection selectors live at the top of `src/content.js`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. |
| `src/ads.js` | Shared ad inventory + the Test-Mode mock ad. |
| `src/content.js` | Detects "generating", injects the sponsored bar, Test mode. |
| `src/inject.css` | Styling for the injected bar (incl. the test badge). |
| `src/background.js` | Service worker — earnings state, revenue math, test counters. |
| `popup/*` | Earnings dashboard, enable + test toggles, demo, bid market. |
| `icons/*` | 16 / 48 / 128 px icons. |
| `test/run.js` | Headless harness (mock DOM + chrome) — `npm test`. |

## Tests

```bash
npm test    # detection on ChatGPT/Claude/Gemini, test mode, 90% math
npm run lint
```

## Settings

Stored in `chrome.storage.local` (defaults in `src/background.js`):
`enabled`, `testMode`, `revenueShare` (0.9), `grossCpm` (12), `blockedCategories`.

---

*Not affiliated with Anthropic, OpenAI, or Google.*
