# FreeAI.fyi — Get paid for waiting 🤑

> Like [kickbacks.ai](https://kickbacks.ai), but **you keep 90%**.

Your agent spends half its life thinking. Claude Code spins. Codex spins. You sit
there reading one line of text — *"Discombobulating…"* — over and over. It's the
**most-watched line in software**.

FreeAI turns that line into a tiny, tasteful ad marketplace and pays **you**,
the developer whose machine showed it, **90% of the revenue.**

## How it works

1. **Install** the extension. No account wall, no config.
2. **Wait, like you already do.** While your agent thinks, a single sponsored line
   appears in the status bar next to a spinner. Subtle, skippable, never blocking.
3. **Get your cut.** Every 5 seconds it serves is one impression — counted only
   while your VS Code window is actually focused, so advertisers pay for ads a
   human could see and an unattended machine earns nothing. Impressions accrue
   earnings at your 90% share; a click is worth 50× an impression. Payouts settle
   weekly via Stripe.

At current rates it comfortably covers an entire Claude or Codex subscription.

## Commands

Open the Command Palette (`Cmd/Ctrl+Shift+P`):

| Command | What it does |
| --- | --- |
| **FreeAI: Show me the money** | Simulates a 30s agent run so you can watch sponsored lines serve and your earnings tick up. |
| **FreeAI: Open earnings dashboard** | Your live earnings, impressions, clicks, and the bid market. |
| **FreeAI: Enable / Disable earning** | Toggle FreeAI on or off. |
| **FreeAI: Open the currently shown ad** | Click through the current sponsored line (counts as a click). |
| **FreeAI: Reset earnings** | Clears local counters (testing). |

The status bar item shows your running earnings when idle, and the live sponsored
line while your agent is working. Click it to open the ad or your dashboard.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `freeai.enabled` | `true` | Earn while you wait. |
| `freeai.revenueShare` | `0.9` | Your cut. We pay **90%** — the better split. |
| `freeai.grossCpm` | `12` | Gross revenue per 1,000 five-second impressions (USD). |
| `freeai.blockedCategories` | `[]` | Ad categories to never show (e.g. `"crypto"`, `"gambling"`). |
| `freeai.autoShowOnTerminal` | `true` | Serve a line while an integrated terminal (where your agent runs) is focused. |

## Privacy

FreeAI **never reads your code, prompts, or agent output.** It only counts
aggregate impressions/clicks and your payout details (via Stripe). Device
credentials are stored in your OS keychain via VS Code SecretStorage. Full
policy at [freeai.fyi/privacy](https://freeai.fyi/privacy).

## Works with

Claude Code · Codex · Cursor · Gemini CLI · VS Code · JetBrains.
Best inside the IDE extensions; the terminal CLIs work too. Apologies, terminal jockeys.

---

*Not affiliated with Anthropic or OpenAI.*
