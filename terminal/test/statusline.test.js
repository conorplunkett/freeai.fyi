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
  assert.match(out.text(), /ad· Try Acme/);
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

test("buildAdLine falls back to non-clickable text when tracking URL is absent", () => {
  assert.equal(buildAdLine({ ad: { line: "Ad" }, trackingUrl: "" }), "ad· Ad");
});
