// Betterbacks API — end-to-end verification.
// Boots the REAL app and REAL repository against a REAL Postgres (DATABASE_URL),
// with only the Stripe network transport faked, then drives the full money loop
// over actual HTTP:
//   advertiser checkout -> webhook activates campaign -> device serves
//   impressions/clicks -> ledger pays 90% -> Connect onboarding -> payout sweep.
//
// Usage: DATABASE_URL=postgres://... node test/run.js   (or: npm test)

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../src/app");
const { createRepo } = require("../src/repo");
const { createStripe, signWebhookPayload } = require("../src/stripe");

const WEBHOOK_SECRET = "whsec_test_secret";

// ---------- fake Stripe transport: records requests, returns realistic bodies ----------
const stripeCalls = [];
const fakeFetch = async (url, opts) => {
  const path = new URL(url).pathname;
  const params = Object.fromEntries(new URLSearchParams(opts.body || ""));
  stripeCalls.push({ path, params });
  const id =
    path === "/v1/checkout/sessions" ? "cs_test_" + crypto.randomBytes(6).toString("hex")
    : path === "/v1/accounts" ? "acct_test_" + crypto.randomBytes(6).toString("hex")
    : path === "/v1/account_links" ? null
    : path === "/v1/transfers" ? "tr_test_" + crypto.randomBytes(6).toString("hex")
    : "obj_test";
  const body =
    path === "/v1/checkout/sessions" ? { id, url: `https://checkout.stripe.com/c/pay/${id}` }
    : path === "/v1/account_links" ? { url: "https://connect.stripe.com/setup/e/test" }
    : { id };
  return { ok: true, status: 200, json: async () => body };
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required — start one with: docker compose up -d db");
    process.exit(1);
  }

  // fresh schema in an isolated namespace
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ns = "bbtest_" + crypto.randomBytes(4).toString("hex");
  await pool.query(`create schema ${ns}`);
  await pool.query(`set search_path to ${ns}`);
  const poolNs = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${ns}`,
  });
  await poolNs.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));

  const config = {
    revenueShare: 0.9,
    dailyImpressionCap: 5000,
    payoutThresholdCents: 1000,
    stripeWebhookSecret: WEBHOOK_SECRET,
    siteUrl: "https://betterbacks.ai",
    adminKey: "test-admin",
  };
  const repo = createRepo(poolNs);
  const stripe = createStripe("sk_test_fake", { fetchImpl: fakeFetch });
  const { server } = createApp({ repo, stripe, config });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  let pass = 0;
  const check = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log("  ✓ " + name); });

  console.log("betterbacks api verification (real postgres, fake stripe transport)\n");

  await check("healthz", async () => {
    const r = await api("GET", "/healthz");
    assert.strictEqual(r.status, 200);
  });

  // ---------- money in ----------
  let campaignId, checkoutCall;
  await check("advertiser checkout creates a pending campaign + Stripe session", async () => {
    const r = await api("POST", "/v1/checkout", {
      email: "ads@linear.app", adLine: "Linear — issue tracking built for speed",
      url: "https://linear.app/", brand: "Linear", pricePerBlock: 5, blocks: 2,
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.checkoutUrl.startsWith("https://checkout.stripe.com/"));
    campaignId = r.body.campaignId;
    checkoutCall = stripeCalls.find((c) => c.path === "/v1/checkout/sessions");
    assert.strictEqual(checkoutCall.params["line_items[0][price_data][unit_amount]"], "500");
    assert.strictEqual(checkoutCall.params["line_items[0][quantity]"], "2");
    assert.strictEqual(checkoutCall.params["metadata[campaign_id]"], campaignId);
  });

  await check("checkout validation rejects bad bids", async () => {
    const bad = await api("POST", "/v1/checkout", {
      email: "x@y.z", adLine: "ok ad line", url: "https://x.com", pricePerBlock: 0.5, blocks: 1,
    });
    assert.strictEqual(bad.status, 400);
  });

  await check("ads are empty before payment; webhook with valid signature activates", async () => {
    let ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 0);
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_x", metadata: { campaign_id: campaignId } } },
    });
    const r = await api("POST", "/v1/webhooks/stripe", payload, {
      "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
    });
    assert.strictEqual(r.status, 200);
    ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 1);
    assert.strictEqual(ads.body.ads[0].line, "Linear — issue tracking built for speed");
    assert.strictEqual(ads.body.revenueShare, 0.9);
  });

  await check("webhook with bad signature is rejected", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { metadata: { campaign_id: campaignId } } } });
    const r = await api("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": "t=1,v1=deadbeef" });
    assert.strictEqual(r.status, 400);
  });

  // ---------- auction ranking ----------
  await check("auction ranks the higher bid first", async () => {
    const r2 = await api("POST", "/v1/checkout", {
      email: "ads@fluidstack.io", adLine: "Fluidstack — building 10GW of compute. Join us.",
      url: "https://fluidstack.io/", brand: "Fluidstack", pricePerBlock: 110, blocks: 1,
    });
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { campaign_id: r2.body.campaignId } } },
    });
    await api("POST", "/v1/webhooks/stripe", payload, {
      "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
    });
    const ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads[0].brand, "Fluidstack"); // $110 outbids $5
    const lb = await api("GET", "/v1/leaderboard");
    assert.strictEqual(lb.body.leaderboard[0].brand, "Fluidstack");
  });

  // ---------- devices & the 90% ledger ----------
  let device;
  await check("device registers and gets credentials", async () => {
    const r = await api("POST", "/v1/devices/register");
    assert.ok(r.body.deviceId && r.body.deviceKey);
    device = r.body;
  });

  await check("events pay exactly 90% and a click pays 50x", async () => {
    // 100 impressions + 1 click on the $5/block campaign
    // gross = (100 + 50) * 500c/1000 = 75c -> dev 67.5c = 67500 millicents
    const r = await api("POST", "/v1/events", {
      ...device, batchKey: "batch-1",
      events: [{ campaignId, impressions: 100, clicks: 1 }],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.creditedMillicents, 67500);
    const e = await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`);
    assert.strictEqual(e.body.earnedUsd, 0.675);
  });

  await check("replayed batch is acknowledged but never double-paid", async () => {
    const r = await api("POST", "/v1/events", {
      ...device, batchKey: "batch-1",
      events: [{ campaignId, impressions: 100, clicks: 1 }],
    });
    assert.strictEqual(r.body.duplicate, true);
    const e = await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`);
    assert.strictEqual(e.body.earnedUsd, 0.675); // unchanged
  });

  await check("bad device credentials are rejected", async () => {
    const r = await api("POST", "/v1/events", {
      deviceId: device.deviceId, deviceKey: "wrong", batchKey: "b", events: [],
    });
    assert.strictEqual(r.status, 401);
  });

  await check("daily impression cap returns 429", async () => {
    const r = await api("POST", "/v1/events", {
      ...device, batchKey: "batch-cap",
      events: [{ campaignId, impressions: 6000, clicks: 0 }],
    });
    assert.strictEqual(r.status, 429);
  });

  await check("campaign never bills past its remaining budget", async () => {
    // fresh device (cap is per device); the $5 campaign has 2000 - 150 = 1850 left
    const d2 = (await api("POST", "/v1/devices/register")).body;
    const r = await api("POST", "/v1/events", {
      ...d2, batchKey: "batch-drain",
      events: [{ campaignId, impressions: 5000, clicks: 0 }],
    });
    // billed only 1850: gross 925c -> dev 832.5c
    assert.strictEqual(r.body.creditedMillicents, 832500);
    const ads = await api("GET", "/v1/ads");
    assert.ok(!ads.body.ads.find((a) => a.id === campaignId), "exhausted campaign still serving");
  });

  // ---------- money out ----------
  await check("connect onboarding creates an Express account + onboarding link", async () => {
    const r = await api("POST", "/v1/connect/onboard", { ...device, email: "dev@example.com" });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.onboardingUrl.includes("connect.stripe.com"));
    const acctCall = stripeCalls.find((c) => c.path === "/v1/accounts");
    assert.strictEqual(acctCall.params.type, "express");
    assert.strictEqual(acctCall.params["capabilities[transfers][requested]"], "true");
  });

  await check("account.updated webhook enables payouts; sweep transfers whole cents", async () => {
    const accountId = stripeCalls.find((c) => c.path === "/v1/accounts") && (await poolNs.query("select stripe_account_id from users limit 1")).rows[0].stripe_account_id;
    const payload = JSON.stringify({
      type: "account.updated",
      data: { object: { id: accountId, charges_enabled: true, payouts_enabled: true } },
    });
    await api("POST", "/v1/webhooks/stripe", payload, {
      "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
    });

    // top the device up over the $10 threshold: 2000 imps on the $110 campaign
    // gross 22000c -> dev 19800c = $198
    const fl = (await api("GET", "/v1/leaderboard")).body; // fluidstack is rank 1
    const fluidId = (await poolNs.query("select id from campaigns where brand = 'Fluidstack'")).rows[0].id;
    await api("POST", "/v1/events", {
      ...device, batchKey: "batch-big",
      events: [{ campaignId: fluidId, impressions: 1000, clicks: 0 }],
    });

    const r = await api("POST", "/v1/admin/payouts", { adminKey: "test-admin" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.paid, 1);
    const transfer = stripeCalls.find((c) => c.path === "/v1/transfers");
    // balance: 67.5c + 9900c = 9967.5c -> pays 9967 whole cents
    assert.strictEqual(transfer.params.amount, "9967");
    assert.strictEqual(transfer.params.currency, "usd");

    // balance reflects the debit
    const e = await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`);
    assert.strictEqual(e.body.paidOutUsd, 99.67);
    assert.ok(Math.abs(e.body.balanceUsd - 0.005) < 1e-9, "leftover sub-cent balance: " + e.body.balanceUsd);
  });

  await check("payout sweep requires the admin key", async () => {
    const r = await api("POST", "/v1/admin/payouts", { adminKey: "nope" });
    assert.strictEqual(r.status, 401);
  });

  // ---------- cleanup ----------
  server.close();
  await poolNs.end();
  await pool.query(`drop schema ${ns} cascade`);
  await pool.end();
  console.log(`\nall ${pass} checks passed — the ledger pays 90%, to the millicent. 🤑`);
})().catch((err) => {
  console.error("\n✗ FAILED:", err.message);
  process.exit(1);
});
