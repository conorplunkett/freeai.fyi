# Betterbacks.ai — Get paid for waiting 🤑

> Like [kickbacks.ai](https://kickbacks.ai), but **you keep 90%**.

Your agent spends half its life thinking. Claude Code spins. Codex spins. You sit
there reading one line of text — *"Discombobulating…"* — over and over. It's the
**most-watched line in software**.

Betterbacks turns that line into a tiny, tasteful ad marketplace and pays **you**,
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
| **Betterbacks: Show me the money** | Simulates a 30s agent run so you can watch sponsored lines serve and your earnings tick up. |
| **Betterbacks: Open earnings dashboard** | Your live earnings, impressions, clicks, and the bid market. |
| **Betterbacks: Enable / Disable earning** | Toggle Betterbacks on or off. |
| **Betterbacks: Open the currently shown ad** | Click through the current sponsored line (counts as a click). |
| **Betterbacks: Reset earnings** | Clears local counters (testing). |

The status bar item shows your running earnings when idle, and the live sponsored
line while your agent is working. Click it to open the ad or your dashboard.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `betterbacks.enabled` | `true` | Earn while you wait. |
| `betterbacks.revenueShare` | `0.9` | Your cut. We pay **90%** — the better split. |
| `betterbacks.grossCpm` | `12` | Gross revenue per 1,000 five-second impressions (USD). |
| `betterbacks.blockedCategories` | `[]` | Ad categories to never show (e.g. `"crypto"`, `"gambling"`). |
| `betterbacks.autoShowOnTerminal` | `true` | Serve a line while an integrated terminal (where your agent runs) is focused. |

## Privacy

Betterbacks **never reads your code, prompts, or agent output.** It only counts
aggregate impressions/clicks and your payout details (via Stripe). Device
credentials are stored in your OS keychain via VS Code SecretStorage. Full
policy at [betterbacks.ai/privacy](https://betterbacks.ai/privacy).

## Works with

Claude Code · Codex · Cursor · Gemini CLI · VS Code · JetBrains.
Best inside the IDE extensions; the terminal CLIs work too. Apologies, terminal jockeys.

---

*Not affiliated with Anthropic or OpenAI.*
