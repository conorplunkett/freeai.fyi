import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FreeAiBackend, linkAccountEmail, readDevice, EMAIL_RE } from "../src/backend.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "freeai-terminal-"));
}

test("EMAIL_RE matches the backend's validation", () => {
  assert.ok(EMAIL_RE.test("a@b.co"));
  assert.ok(!EMAIL_RE.test("nope"));
  assert.ok(!EMAIL_RE.test("a@b"));
  assert.ok(!EMAIL_RE.test("a b@c.co"));
});

test("requestEmailLink posts device creds + email to /v1/auth/request-link", async () => {
  const calls = [];
  const backend = new FreeAiBackend({
    base: "https://api.example",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
    },
  });
  const res = await backend.requestEmailLink({ deviceId: "d1", deviceKey: "k1" }, "me@example.com");
  assert.deepEqual(res, { ok: true, sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/v1/auth/request-link");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "me@example.com",
    deviceId: "d1",
    deviceKey: "k1",
  });
});

test("requestEmailLink surfaces the backend's error message", async () => {
  const backend = new FreeAiBackend({
    base: "https://api.example",
    fetchImpl: async () => new Response(JSON.stringify({ error: "valid email required" }), { status: 400 }),
  });
  await assert.rejects(
    () => backend.requestEmailLink({ deviceId: "d", deviceKey: "k" }, "x"),
    /valid email required/
  );
});

test("linkAccountEmail registers a device first, then links it", async () => {
  const home = tempHome();
  let registered = 0;
  const linked = [];
  const backend = {
    async registerDevice() { registered++; return { deviceId: "dev-1", deviceKey: "key-1" }; },
    async requestEmailLink(device, email) { linked.push({ device, email }); return { ok: true, sent: true }; },
  };

  const res = await linkAccountEmail(home, backend, "  me@example.com  ");
  assert.equal(res.email, "me@example.com");
  assert.equal(res.deviceId, "dev-1");
  assert.equal(registered, 1);
  assert.deepEqual(linked[0], { device: { deviceId: "dev-1", deviceKey: "key-1" }, email: "me@example.com" });
  // Device persisted so a re-link reuses it instead of registering again.
  assert.deepEqual(readDevice(home), { deviceId: "dev-1", deviceKey: "key-1" });

  await linkAccountEmail(home, backend, "me@example.com");
  assert.equal(registered, 1, "existing device is reused");
});

test("linkAccountEmail rejects an invalid email before touching the network", async () => {
  const home = tempHome();
  let touched = false;
  const backend = {
    async registerDevice() { touched = true; return { deviceId: "x", deviceKey: "y" }; },
    async requestEmailLink() { touched = true; return { ok: true }; },
  };
  await assert.rejects(() => linkAccountEmail(home, backend, "nope"), /valid email required/);
  assert.equal(touched, false);
});

test("linkStatus reports linked accounts via /v1/me/affiliate", async () => {
  const backend = new FreeAiBackend({
    base: "https://api.example",
    fetchImpl: async (url) => {
      assert.match(url, /\/v1\/me\/affiliate\?/);
      assert.match(url, /deviceId=d1/);
      return new Response(JSON.stringify({ linked: true, email: "me@example.com" }), { status: 200 });
    },
  });
  assert.deepEqual(await backend.linkStatus({ deviceId: "d1", deviceKey: "k1" }), {
    linked: true,
    email: "me@example.com",
  });
});
