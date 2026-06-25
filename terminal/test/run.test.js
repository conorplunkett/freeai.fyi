import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/run.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

test("runClaude forwards args through a temporary --settings file", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const fakeClaude = join(cwd, "claude-fake.js");
  const argsPath = join(cwd, "args.json");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('2.1.143 (Claude Code)');
  process.exit(0);
}
fs.writeFileSync(process.env.FAKE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
process.exit(7);
`, "utf8");
  chmodSync(fakeClaude, 0o755);

  const backend = {
    async config() { return { serving: true }; },
    async ads() { return [{ id: "ad1", line: "Try Acme", url: "https://ad.example" }]; },
    async registerDevice() { return { deviceId: "dev", deviceKey: "key" }; },
    async createClickIntent() { return "https://api.example/v1/go/tok"; },
    async sendImpression() { return { ok: true }; },
  };

  const code = await runClaude(["--model", "sonnet", "fix bug"], {
    home,
    cwd,
    env: { ...process.env, FAKE_ARGS_PATH: argsPath },
    realClaudePath: fakeClaude,
    cliPath: "/opt/freeai/bin/freeai.js",
    backend,
    keepSession: true,
    monitorOptions: { intervalMs: 1000 },
  });
  assert.equal(code, 7);
  const args = JSON.parse(readFileSync(argsPath, "utf8"));
  assert.equal(args[0], "--settings");
  assert.equal(args[2], "--model");
  assert.equal(args[3], "sonnet");
  assert.equal(args[4], "fix bug");
  const sessions = readdirSync(join(home, ".freeai", "claude", "sessions"));
  assert.equal(sessions.length, 1);
  const settings = JSON.parse(readFileSync(join(home, ".freeai", "claude", "sessions", sessions[0], "settings.json"), "utf8"));
  assert.match(settings.statusLine.command, /claude statusline/);
  assert.deepEqual(settings.spinnerVerbs, { mode: "replace", verbs: ["Try Acme"] });
});

test("runClaude falls back to unchanged args when FreeAI preparation fails", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const fakeClaude = join(cwd, "claude-fake.js");
  const argsPath = join(cwd, "args.json");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`, "utf8");
  chmodSync(fakeClaude, 0o755);
  const backend = { async config() { throw new Error("offline"); } };
  const code = await runClaude(["--settings", "user.json", "fix"], {
    home,
    cwd,
    env: { ...process.env, FAKE_ARGS_PATH: argsPath },
    realClaudePath: fakeClaude,
    backend,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), ["--settings", "user.json", "fix"]);
});

test("spinner verbs are still written when `claude --version` detection fails", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const fakeClaude = join(cwd, "claude-fake.js");
  // --version exits non-zero (unparseable) — detection returns null. The ad must
  // still replace the spinner line rather than being silently dropped.
  writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.exit(1); }
process.exit(0);
`, "utf8");
  chmodSync(fakeClaude, 0o755);

  const backend = {
    async config() { return { serving: true }; },
    async ads() { return [{ id: "ad1", brand: "Acme", line: "Try Acme", url: "https://ad.example" }]; },
    async registerDevice() { return { deviceId: "dev", deviceKey: "key" }; },
    async createClickIntent() { return "https://api.example/v1/go/tok"; },
    async sendImpression() { return { ok: true }; },
  };

  await runClaude(["fix"], {
    home, cwd, env: process.env, realClaudePath: fakeClaude,
    cliPath: "/opt/freeai/bin/freeai.js", backend, keepSession: true,
    monitorOptions: { intervalMs: 1000 },
  });
  const sessions = readdirSync(join(home, ".freeai", "claude", "sessions"));
  const settings = JSON.parse(readFileSync(join(home, ".freeai", "claude", "sessions", sessions[0], "settings.json"), "utf8"));
  assert.deepEqual(settings.spinnerVerbs, { mode: "replace", verbs: ["Acme — Try Acme"] });
});
