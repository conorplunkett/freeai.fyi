import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShellBlock, restoreShellBlock, MARKER_START, MARKER_END } from "../src/shell.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

test("installShellBlock inserts and replaces a reversible zsh alias block", () => {
  const dir = tempDir();
  const rc = join(dir, ".zshrc");
  writeFileSync(rc, "export FOO=1\n", "utf8");

  const installed = installShellBlock({ shell: "zsh", rcPath: rc });
  assert.equal(installed.changed, true);
  const first = readFileSync(rc, "utf8");
  assert.match(first, /alias claude="freeai claude run"/);
  assert.match(first, new RegExp(MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  installShellBlock({ shell: "zsh", rcPath: rc });
  const second = readFileSync(rc, "utf8");
  assert.equal(second.match(/FreeAI Claude terminal integration/g).length, 2);

  const restored = restoreShellBlock({ shell: "zsh", rcPath: rc });
  assert.equal(restored.changed, true);
  assert.equal(readFileSync(rc, "utf8"), "export FOO=1\n");
});

test("installShellBlock aborts on an existing non-FreeAI claude alias unless forced", () => {
  const dir = tempDir();
  const rc = join(dir, ".bashrc");
  writeFileSync(rc, "alias claude=/opt/claude\n", "utf8");

  assert.throws(() => installShellBlock({ shell: "bash", rcPath: rc }), /existing claude/);
  installShellBlock({ shell: "bash", rcPath: rc, force: true });
  const content = readFileSync(rc, "utf8");
  assert.match(content, /alias claude=\/opt\/claude/);
  assert.match(content, /alias claude="freeai claude run"/);
});

test("installShellBlock writes fish function syntax", () => {
  const dir = tempDir();
  const rc = join(dir, "config.fish");
  installShellBlock({ shell: "fish", rcPath: rc });
  const content = readFileSync(rc, "utf8");
  assert.match(content, /function claude/);
  assert.match(content, /freeai claude run \$argv/);
  assert.match(content, new RegExp(MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
