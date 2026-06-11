# Betterbacks.ai 🤑

**Get paid for waiting.** Like [kickbacks.ai](https://kickbacks.ai), but better —
**you keep 90% of the revenue** instead of 50%.

Your agent spends half its life thinking. Claude Code spins, Codex spins, and you
read one line — *"Discombobulating…"* — over and over. It's the most-watched line in
software. Betterbacks turns it into a tiny ad marketplace and pays the developer
whose machine showed the ad.

## What's in here

| Path | What it is |
| --- | --- |
| [`index.html`](index.html) · [`styles.css`](styles.css) · [`script.js`](script.js) | The marketing site — hero, live bid market, advertiser checkout, leaderboard. A faithful clone of kickbacks.ai with a 90% split. |
| [`privacy.html`](privacy.html) | Privacy policy. |
| [`extension/`](extension/) | The **VS Code extension** that serves sponsored lines in the Claude Code / Codex spinner and tracks your earnings. The main focus. |
| [`storage/`](storage/) | Shelved pieces — currently the Chrome extension for web agents (works, on ice for now). |

## Run the site locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Run the extension locally

```bash
cd extension
code .          # open in VS Code, then press F5 to launch an Extension Development Host
```

Then run **"Betterbacks: Show me the money"** from the Command Palette to watch
sponsored lines serve and your earnings tick up. See
[`extension/README.md`](extension/README.md) for full docs.

## Verify it works without VS Code

```bash
cd extension
npm test        # runs the mock-vscode harness: activates the extension,
                # simulates an agent run, and asserts the 90% revenue math
```

## Chrome extension?

Built and working, but shelved for now while we nail the VS Code replica — see
[`storage/`](storage/).

## The kicker

| | kickbacks.ai | **Betterbacks.ai** |
| --- | --- | --- |
| Developer revenue share | 50% | **90%** |

---

*Not affiliated with Anthropic or OpenAI.*
