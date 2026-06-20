# Submitting FreeAI to the Chrome Web Store

Step-by-step guide to publish (and later update) the FreeAI Chrome extension on
the [Chrome Web Store](https://chrome.google.com/webstore/devconsole). The
paste-ready listing copy and the per-permission justifications below are the
parts reviewers actually read — keep them in sync with `manifest.json`.

> **TL;DR:** `make package-ext` → upload the zip → fill the listing fields below
> → answer the privacy/permissions form → submit. First review is usually a few
> business days.

---

## 0. One-time setup (first publish only)

1. **Register a developer account** at
   <https://chrome.google.com/webstore/devconsole> with the Google account that
   should own the listing. Prefer a project/role account (not a personal inbox)
   so ownership survives.
2. **Pay the one-time $5 USD registration fee.** Required before you can publish.
3. **Verify the publisher.** Set a public contact email in the console and
   verify it — unverified publishers can't go live.
4. **(Recommended) Verify the `freeai.fyi` domain** in
   [Google Search Console](https://search.google.com/search-console) under the
   same account. This lets you list `https://freeai.fyi` as the official site
   and reduces "is this really you?" review friction.

---

## 1. Build the package

```bash
make package-ext          # or: tools/package-extension.sh
```

This writes `chrome-extension/dist/freeai-chrome-v<version>.zip` containing
**only** the 12 runtime files (manifest, icons, `src/*`, `popup/*`). It will
**refuse to build** if `popup/theme.css` has drifted from the root `theme.css`
(the AGENTS.md mirror rule) or if any JS fails the syntax lint — fix those first.

> The version in the zip name comes from `manifest.json` → `"version"`. The Web
> Store requires the version to **increase** on every update; bump it there
> before re-packaging (see [§7](#7-publishing-an-update)).

---

## 2. Create the listing → upload

In the Developer Dashboard: **Add new item** → upload
`chrome-extension/dist/freeai-chrome-v<version>.zip`. The console reads the
manifest and pre-fills name, version, and icons. Then complete the tabs below.

### Store listing fields (paste-ready)

| Field | Value |
| --- | --- |
| **Name** | `FreeAI.fyi — Earn from ChatGPT, Claude & Gemini` (from manifest) |
| **Summary** (132 char max) | `A subtle sponsored line shows while ChatGPT, Claude & Gemini think — 50% of the revenue comes back as Claude credits.` |
| **Category** | Productivity |
| **Language** | English |
| **Official website** | `https://freeai.fyi` |
| **Support / contact** | `privacy@freeai.fyi` (or your support inbox) |
| **Privacy policy URL** | `https://freeai.fyi/privacy` |

**Detailed description** (paste into the description box):

```
FreeAI turns the AI "thinking" spinner into a tiny ad marketplace — and gives
you half the money back as Claude credits.

While ChatGPT, Claude, or Gemini is generating an answer, FreeAI shows ONE
subtle, clickable sponsored line right by the reply. That's it. When the model
finishes, the line fades away. 50% of the ad revenue accrues to you as credits
you can redeem for Claude on freeai.fyi.

WHAT IT DOES
• Shows a single, tasteful sponsored line only while the assistant is thinking.
• Tracks impressions and clicks locally and shows your live earnings in the popup.
• Test mode renders a labelled mock ad so you can see exactly how it looks,
  without touching real earnings.
• A "Show me the money" button runs a 30-second demo on the current tab.

WHAT IT DOES NOT DO
• It never reads, stores, or transmits your prompts or the model's answers.
• It only detects the on/off "is it generating right now?" state of the page.
• No keystroke logging. No selling your data — the only data we have is
  "a spinner showed an ad."

SUPPORTED SITES
ChatGPT (chatgpt.com / chat.openai.com), Claude (claude.ai), Gemini
(gemini.google.com), Google AI Studio, Perplexity, v0.dev, and bolt.new.

HOW EARNINGS WORK
Every 5 seconds an ad is shown = one impression; a click is worth 50×. Credits
accrue at your 50% share and are redeemable for Claude gift cards on freeai.fyi
after you sign in.

Not affiliated with Anthropic, OpenAI, or Google.
```

---

## 3. Privacy practices form (required — read carefully)

The Web Store will not publish until this is filled out, and mismatches here are
the #1 cause of rejection. Answer it to match what the code actually does
(`src/background.js` is the only thing that talks to the network).

- **Single purpose** (paste):
  > FreeAI displays a single sponsored line while an AI assistant is generating a
  > response, and returns 50% of the ad revenue to the user as credits. Its one
  > purpose is showing context-appropriate ads during AI "thinking" time.

- **Data usage disclosures** — check honestly:
  - **Does NOT collect** prompts, page content, model output, keystrokes,
    personal communications, health/financial/location/web-history data, or
    authentication info.
  - **Collects** only anonymous, aggregate **ad impression/click counts** tied
    to an **anonymous device ID** (no account, no PII), reported to the FreeAI
    backend to compute earnings.
  - Affirm: data is **not sold**, **not used for unrelated purposes**, and
    **not used for creditworthiness/lending**.
  - You **do** transmit data to a remote server (the impression/click counts) —
    declare it and point to the privacy policy.

- **Remote code**: Answer **No** — the extension executes no remotely-hosted
  code. It only `fetch`es JSON ad data/config from the backend; it never loads or
  `eval`s remote scripts. (Keep it that way; remote code triggers deep review.)

### Permission justifications (paste one per permission)

The console asks you to justify every permission in `manifest.json`. Accurate,
specific justifications keep review fast:

| Permission | Justification |
| --- | --- |
| `storage` | Stores the user's earnings counters, settings (enabled, test mode, blocked categories), and the anonymous device ID locally via `chrome.storage`. |
| `alarms` | Schedules periodic background tasks: refreshing the ad inventory/config and flushing batched impression events to the ledger (`chrome.alarms`, every 1–10 min). |
| **Host permissions** (claude.ai, chatgpt.com, chat.openai.com, gemini.google.com, aistudio.google.com, perplexity.ai, v0.dev, bolt.new) | The content script must run on these AI chat sites to detect the "generating" state and inject the single sponsored line at the reply. |
| Host permission: `wpjfhezklpczxzocgxsb.supabase.co` | The backend API: registers the anonymous device, pulls live ad inventory/config, and reports impression/click counts to compute earnings. |

---

## 4. Graphic assets to upload

Gather these before you start the listing (the console blocks publish without an
icon + at least one screenshot):

| Asset | Spec | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | ✅ ships in `icons/icon128.png` |
| Screenshots | **1280×800** (or 640×400) PNG/JPEG, 1–5 images | ⚠️ **need to capture** |
| Small promo tile | 440×280 PNG | ⚠️ optional but recommended for featuring |
| Marquee promo tile | 1400×560 PNG | ⚠️ optional |

**Screenshot ideas** (capture from a real session — flip on **Test mode** so the
labelled mock ad renders on demand, see `README.md`):

1. The sponsored line rendered under a streaming Claude/ChatGPT reply.
2. The popup showing live earnings + the enable/test toggles.
3. The "Show me the money" demo mid-run.

---

## 5. Distribution & visibility

- **Visibility:** Public (or Unlisted if you want a soft launch via direct link).
- **Regions:** All regions, unless you have a reason to restrict.
- **Pricing:** Free.

---

## 6. Pre-submit checklist

- [ ] `make test-ext` and `make lint-ext` pass.
- [ ] `manifest.json` `version` bumped (for updates) and matches the zip name.
- [ ] `make package-ext` succeeded (mirror + lint gates green).
- [ ] Zip contains only the 12 runtime files — no `test/`, `node_modules/`,
      `README.md`, or `GEMINI_BUG_HANDOFF.md` (the script guarantees this).
- [ ] Privacy policy is live at `https://freeai.fyi/privacy` and **matches the
      data-usage answers** (see the note in [§8](#8-anything-else--open-items)).
- [ ] At least one 1280×800 screenshot uploaded.
- [ ] Permission justifications pasted for every permission.
- [ ] "Remote code" answered **No**.

Then: **Submit for review**. First reviews typically take a few business days;
you'll get an email on approval or rejection (with the reason).

---

## 7. Publishing an update

1. Bump `"version"` in `chrome-extension/manifest.json` (and `package.json` to
   keep them aligned). Store versions must strictly increase.
2. `make package-ext`.
3. Dashboard → the existing item → **Package** → upload the new zip → **Submit
   for review**. Listing copy/assets persist; only changed fields need editing.

---

## 8. Anything else — open items

Things worth resolving before (or shortly after) the first submission — none
block packaging, but they affect review and trust:

1. **The open Gemini placement bug.** `GEMINI_BUG_HANDOFF.md` documents an
   unfixed ad-bar placement bug in Gemini's dots-only stage. Not a blocker, but
   ship-quality-wise it's the most visible defect on a supported site — consider
   fixing it (or temporarily dropping `gemini.google.com` from the listed
   "supported sites") before a big launch.
2. **Screenshots/promo tiles** ([§4](#4-graphic-assets-to-upload)) are the only
   hard *missing* artifacts — everything else is in the repo.

Already handled: the privacy policy (`privacy.html`) now describes the
extension's real data flows (anonymous device ID, impression/click counts to the
**Supabase** backend, email only on website redeem), and the unneeded `tabs`
permission was removed from the manifest (`chrome.tabs.query`/`sendMessage` only
use `tab.id`, which works without it).
