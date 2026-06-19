import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFreeAiStatusLine, effectiveStatusLine, extractSettingsArg,
  readSettingsValue, writeSessionSettings } from "../src/settings.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

test("extractSettingsArg removes --settings while preserving user args", () => {
  assert.deepEqual(
    extractSettingsArg(["--model", "sonnet", "--settings", "s.json", "fix"]),
    { cleanArgv: ["--model", "sonnet", "fix"], settingsValue: "s.json" },
  );
  assert.deepEqual(
    extractSettingsArg(["--settings={\"a\":1}", "--", "--settings", "literal"]),
    { cleanArgv: ["--", "--settings", "literal"], settingsValue: "{\"a\":1}" },
  );
});

test("readSettingsValue parses JSONC files and inline JSON", () => {
  const dir = tempDir();
  const file = join(dir, "settings.json");
  writeFileSync(file, "{\n  // keep comments\n  \"model\": \"opus\",\n}\n", "utf8");
  assert.deepEqual(readSettingsValue(file, dir), { model: "opus" });
  assert.deepEqual(readSettingsValue("{\"model\":\"sonnet\"}", dir), { model: "sonnet" });
});

test("effectiveStatusLine follows home, project, local, user precedence", () => {
  const home = tempDir();
  const cwd = tempDir();
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "echo home" } }), "utf8");
  writeFileSync(join(cwd, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "echo project" } }), "utf8");
  writeFileSync(join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ statusLine: { type: "command", command: "echo local" } }), "utf8");
  assert.equal(effectiveStatusLine({ home, cwd }).command, "echo local");
  assert.equal(effectiveStatusLine({
    home, cwd, userSettings: { statusLine: { type: "command", command: "echo user" } },
  }).command, "echo user");
});

test("writeSessionSettings preserves user keys and overwrites statusLine", () => {
  const dir = tempDir();
  const path = join(dir, "settings.json");
  const statusLine = buildFreeAiStatusLine({
    nodePath: "/node", cliPath: "/freeai", statePath: "/state.json", prevPath: "/prev.json",
  });
  const out = writeSessionSettings({
    path,
    userSettings: { model: "opus", statusLine: { type: "command", command: "echo old" } },
    statusLine,
    spinnerVerbs: { mode: "replace", verbs: ["Ad"] },
  });
  assert.equal(out.model, "opus");
  assert.equal(out.statusLine.command, "'/node' '/freeai' claude statusline --state '/state.json' --prev '/prev.json'");
  assert.deepEqual(out.spinnerVerbs, { mode: "replace", verbs: ["Ad"] });
});
