import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API_BASE, resolveApiBase } from "../src/paths.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

test("resolveApiBase uses FreeAI config, env, then default", () => {
  const home = tempDir();
  assert.equal(resolveApiBase({ home, env: {} }), DEFAULT_API_BASE);
  assert.equal(
    resolveApiBase({ home, env: { FREEAI_BASE: "http://127.0.0.1:8787/api/" } }),
    "http://127.0.0.1:8787/api",
  );

  mkdirSync(join(home, ".freeai"), { recursive: true });
  writeFileSync(join(home, ".freeai", "config.json"), JSON.stringify({
    backendBaseUrl: "https://api.example.test/freeai/",
  }), "utf8");
  assert.equal(
    resolveApiBase({ home, env: { FREEAI_BASE: "http://127.0.0.1:8787/api" } }),
    "https://api.example.test/freeai",
  );
});
