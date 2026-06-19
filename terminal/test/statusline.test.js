import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { initialState, writeState } from "../src/state.js";
import { buildAdLine, runStatusLine } from "../src/statusline.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

function capture() {
  let out = "";
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString("utf8");
        cb();
      },
    }),
    text: () => out,
  };
}

// The ad line is now styled (color/bold/shimmer) and OSC 8-wrapped; strip both
// to assert on the visible text.
function stripAnsi(value) {
  return String(value)
    .replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "")
    .replace(/\u001b\[[0-9;]*m/g, "");
}

test("runStatusLine prints a clickable ad only for an active transcript", async () => {
  const dir = tempDir();
  const statePath = join(dir, "state.json");
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript,
    "{\"entrypoint\":\"cli\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    "utf8");
  writeState(statePath, initialState({
    sessionId: "s1",
    ad: { id: "ad1", line: "Try Acme\u001b[31m", url: "https://ad.example" },
    trackingUrl: "https://api.example/v1/go/tok",
  }));

  const out = capture();
  await runStatusLine({
    statePath,
    stdin: Readable.from([JSON.stringify({ transcript_path: transcript })]),
    stdout: out.stream,
  });
  assert.match(out.text(), /\u001b]8;;https:\/\/api\.example\/v1\/go\/tok/);
  assert.match(stripAnsi(out.text()), /ad· Try Acme/);
  assert.doesNotMatch(out.text(), /\u001b\[31m/);
});

test("runStatusLine suppresses ad while idle and still chains previous statusLine", async () => {
  const dir = tempDir();
  const statePath = join(dir, "state.json");
  const transcript = join(dir, "session.jsonl");
  const prevScript = join(dir, "prev.js");
  const prevPath = join(dir, "prev.json");
  writeFileSync(transcript,
    "{\"entrypoint\":\"cli\"}\n{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\",\"content\":[]}}\n",
    "utf8");
  writeFileSync(prevScript, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('prev-line'));\n", "utf8");
  writeFileSync(prevPath, JSON.stringify({
    statusLine: { type: "command", command: `${process.execPath} ${prevScript}` },
  }), "utf8");
  writeState(statePath, initialState({
    sessionId: "s1",
    ad: { id: "ad1", line: "Try Acme", url: "https://ad.example" },
    trackingUrl: "https://api.example/v1/go/tok",
  }));

  const out = capture();
  await runStatusLine({
    statePath,
    prevPath,
    stdin: Readable.from([JSON.stringify({ transcript_path: transcript })]),
    stdout: out.stream,
  });
  assert.equal(out.text(), "prev-line");
});

test("buildAdLine falls back to styled, non-clickable text when tracking URL is absent", () => {
  const out = buildAdLine({ ad: { line: "Ad" }, trackingUrl: "" });
  assert.equal(stripAnsi(out), "ad· Ad");
  assert.doesNotMatch(out, /\u001b]8;;/); // no hyperlink without a tracking URL
});

test("buildAdLine renders brand, advertiser color and a clickable link", () => {
  const out = buildAdLine({
    ad: { brand: "Linear", line: "Plan your next sprint faster", color: "#5b5bd6" },
    trackingUrl: "https://api.example/v1/go/tok",
  }, { now: 0 });
  assert.equal(stripAnsi(out), "ad· Linear — Plan your next sprint faster");
  assert.match(out, /\u001b\[1m/);              // bold
  assert.match(out, /\u001b\[38;2;91;91;214m/); // advertiser color #5b5bd6
  assert.match(out, /\u001b]8;;https:\/\/api\.example\/v1\/go\/tok/); // clickable
});
