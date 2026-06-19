# FreeAI Terminal

Standalone Claude Code terminal integration.

## Commands

```bash
cd terminal
npm test
node bin/freeai.js claude setup
```

| Command | What |
| --- | --- |
| `freeai claude setup` | Locate the real `claude`, store it in `~/.freeai/claude/config.json`, and add a marked shell alias/function. |
| `freeai claude run [...args]` | Internal wrapper used by the alias. It forwards args, cwd, env, stdio, signals, and Claude's exit code. |
| `freeai claude restore` | Remove the marked shell block. Safe to run repeatedly. |
| `freeai claude doctor` | Print the resolved Claude path, config/shell/rc paths, then probe the backend pipeline (config → ads → device → click-intent) and report an `adsWillServe` verdict. Pass `--no-backend` to skip the network probe. |

### Debugging "no ad shows"

The ad path is silent in normal use, so `doctor` can be green on the local
machine while no ad serves. Two diagnostics:

- `freeai claude doctor` — the `adsWillServe` field plus per-step `ok`/`error`
  shows whether the backend pipeline succeeds (network reachable, ad in
  rotation, device + click-intent created).
- `FREEAI_DEBUG=1 claude` — traces to stderr whether the wrapper ran and which
  step, if any, caused it to fall back to plain `claude`. No `freeai[debug]`
  output means the shell alias isn't active (`type claude` to confirm).

`setup` adds a marked, reversible shell alias/function so `claude ...` becomes
`freeai claude run ...`. zsh/bash use:

```sh
alias claude="freeai claude run"
```

fish uses an equivalent `claude` function that forwards `$argv`.

## Claude Code Integration

Reference surfaces:

- Claude Code status line docs: https://code.claude.com/docs/en/statusline
- Claude Code `--settings` CLI docs: https://code.claude.com/docs/en/cli-reference

The wrapper launches the real Claude Code binary with a temporary `--settings`
file containing a FreeAI `statusLine` command. It preserves any user-supplied
`--settings` value by parsing and merging it into the temporary settings file,
then chains any pre-existing effective user/project/local `statusLine`.

The status line command receives Claude Code's JSON status payload on stdin. It
uses `transcript_path` plus structural transcript rows to decide whether Claude
is actively thinking. When active, it prints one clickable OSC 8 `ad· <line>`
that points at a `/v1/go/:token` URL from `/v1/clicks/intent`. When idle, it
prints only the user's original status line, or nothing.

It never edits the real Claude binary, npm shim, or persistent
`~/.claude/settings.json`. If config, ad fetch, device registration, click-intent
creation, settings parsing, or any other FreeAI preparation step fails, `run`
executes Claude unchanged.

Hooks are intentionally not used in v1. The supported integration surface is
Claude Code `statusLine` plus a session-scoped `--settings` file.

## State And Billing

Runtime state is stored under `~/.freeai/claude/sessions/<session-id>/` and is
removed when Claude exits. Device credentials are stored in `~/.freeai`, matching
the existing Chrome extension device-credit backend.

An impression is emitted to `/v1/events` only after 5 continuous active seconds
with a fresh statusline heartbeat. Clicks use `/v1/clicks/intent` tracking URLs;
the terminal client does not self-report click counts through `/v1/events`.

## Backend Configuration

The default API base is the production Supabase Edge Function. It can be
overridden with `~/.freeai/config.json`:

```json
{
  "backendBaseUrl": "http://127.0.0.1:8787"
}
```

or with `FREEAI_BASE` when no config file override is set.

## Tests

```bash
make test-terminal
# or
cd terminal && npm test
```
