<h1 align="center">FreeAI.fyi — VS Code / Cursor extension</h1>

<p align="center"><em>Get paid while you code. 50% of ad revenue comes back to you as Claude credits.</em></p>

<p align="center">
  <a href="https://freeai.fyi">freeai.fyi</a> ·
  <a href="https://github.com/conorplunkett/freeai.fyi">GitHub</a>
</p>

---

> **Status: incubating (not shipped).** This is the editor-side sibling of the
> FreeAI Chrome extension, vendored from a mature upstream codebase and rebranded
> to FreeAI. It **builds, type-checks, and passes its full test suite today**, and
> its backend URL points at the production Supabase Edge Function and it talks to the existing
> FreeAI server endpoints via the adapter in `src/freeaiApi/` (see
> [`INTEGRATION.md`](INTEGRATION.md)). **No existing FreeAI functionality (Chrome
> extension, server, site, macOS app) is touched by this directory.**

## What it is

The FreeAI Chrome extension sells the "thinking…" line inside **web** AI
assistants (ChatGPT / Claude / Gemini). This extension does the same thing for
**editor agents**: while **Claude Code** or **Codex** is thinking, their spinner
shows a random verb ("Discombobulating…", "Baking…"). FreeAI turns that one line
into a tiny, tasteful, **clickable** sponsored slot, and returns **50% of the ad
revenue** to the developer whose machine rendered it — redeemable as Claude
credits, exactly like the web product.

It works on four surfaces, one extension:

| Surface | Where | Needs |
| --- | --- | --- |
| **Spinner overlay** | Claude Code VS Code panel | A compatible extension build |
| **Thinking-shimmer** | Codex VS Code panel | A compatible extension build |
| **Status-bar line** | Claude Code terminal CLI | Any Claude Code version |
| **Spinner verb** | Claude Code terminal CLI | Claude Code **2.1.143+** |

VS Code surfaces work on local, Remote-SSH, devcontainers, and code-server. It
runs unchanged in **Cursor** (a VS Code fork). Older CLIs keep their stock verbs
— nothing breaks. Everything is fully reversible (one command restores Claude
Code byte-for-byte) and it **never reads your code, prompts, or completions**.

## Develop

```bash
cd vscode-extension
npm install
npm run build        # esbuild → dist/extension.js + injection assets
npm run typecheck    # tsc --noEmit
npm test             # vitest — the editor-safety net (902 tests)
npm run package      # produce the .vsix (requires @vscode/vsce)
```

Brand/config knobs:

- **Backend:** `src/config.ts` → `DEFAULT_BACKEND_BASE`
  (`https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api`, the production
  Supabase Edge Function; the `api.freeai.fyi` hostname rewrites onto it).
  Overridable per-machine via `~/.freeai/config.json` (`backendBaseUrl`) or the
  `FREEAI_BASE` env var.
- **Brand assets:** `npm run icon` regenerates `media/icon.png` from
  `scripts/_brand.mjs` (FreeAI orange `#d97757`; needs Playwright + Montserrat).
  The committed `media/icon.png` is the FreeAI mark from the Chrome extension.
- **Commands / config namespace:** `freeai.*` (with `freeai-legacy.*` aliases).
  Config dir: `~/.freeai/`.

## Layout

```
src/
  adapters/        per-tool injection (claude-code, codex, claude-cli, codex-cli)
  activation/      lifecycle: ad rotation, self-update, status bar, injection
  auth/            sign-in + OS-keychain-sealed token vault
  metrics/         impression / view-threshold / click telemetry (idempotent)
  viewTracking/    "was it actually on screen long enough?" timer
  killswitch/      server-controlled global off-switch
  freeaiApi/       adapter mapping the clients' S2 contract → FreeAI endpoints
media/icon.png     marketplace icon (FreeAI mark)
test/              the vitest suite that guards editor safety
INTEGRATION.md     endpoint-gap analysis + plan to wire to api.freeai.fyi
```

## License

MIT © 2026 FreeAI.fyi — see [`LICENSE`](LICENSE). Same license as the rest of
the FreeAI repositories.
