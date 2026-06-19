import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delay } from "../src/util.js";
import { startSessionMonitor } from "../src/monitor.js";
import { initialState, readState, writeState } from "../src/state.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

test("monitor sends one impression after continuous active time with statusline heartbeat", async () => {
  const home = tempDir();
  const dir = tempDir();
  const statePath = join(dir, "state.json");
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript,
    "{\"entrypoint\":\"cli\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    "utf8");
  const state = initialState({
    sessionId: "s1",
    ad: { id: "ad1", line: "Ad", url: "https://ad.example" },
    trackingUrl: "https://api.example/v1/go/tok",
  });
  state.lastHeartbeatMs = Date.now();
  state.transcriptPath = transcript;
  writeState(statePath, state);

  const sent = [];
  const monitor = startSessionMonitor({
    statePath,
    home,
    ad: { id: "ad1" },
    device: { deviceId: "dev", deviceKey: "key" },
    backend: {
      async sendImpression(_device, campaignId, batchKey) {
        sent.push({ campaignId, batchKey });
        return { ok: true };
      },
    },
    intervalMs: 10,
    viewThresholdMs: 30,
    heartbeatFreshMs: 1000,
    transcriptFreshMs: 1000,
  });
  await delay(90);
  monitor.stop();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].campaignId, "ad1");
  assert.equal(readState(statePath).impression.sent, true);
});

test("monitor does not bill without a statusline heartbeat", async () => {
  const home = tempDir();
  const dir = tempDir();
  const statePath = join(dir, "state.json");
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript,
    "{\"entrypoint\":\"cli\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    "utf8");
  const state = initialState({
    sessionId: "s1",
    ad: { id: "ad1", line: "Ad", url: "https://ad.example" },
    trackingUrl: "https://api.example/v1/go/tok",
  });
  state.transcriptPath = transcript;
  writeState(statePath, state);

  let count = 0;
  const monitor = startSessionMonitor({
    statePath,
    home,
    ad: { id: "ad1" },
    device: { deviceId: "dev", deviceKey: "key" },
    backend: { async sendImpression() { count++; return { ok: true }; } },
    intervalMs: 10,
    viewThresholdMs: 20,
    heartbeatFreshMs: 1000,
    transcriptFreshMs: 1000,
  });
  await delay(60);
  monitor.stop();
  assert.equal(count, 0);
});
