// FreeAI API — end-to-end verification.
// Boots the REAL app + repository against a REAL Postgres (DATABASE_URL), with
// only Stripe + mail transports faked, and drives the full hardened flow:
//   checkout -> webhook (deduped) -> moderation -> auction -> 90% ledger ->
//   server-side clicks -> email-gated Connect onboarding -> payouts; plus XSS
//   escaping, rate limiting, body caps, and CORS.
//
// Usage: DATABASE_URL=postgres://... node test/run.js   (or: npm test)

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../src/app");
const { createRepo } = require("../src/repo");
const { createStripe, signWebhookPayload } = require("../src/stripe");
const { createRateLimiter } = require("../src/ratelimit");

const WEBHOOK_SECRET = "whsec_test_secret";

// ---------- fake Stripe transport ----------
const stripeCalls = [];
const fakeFetch = async (url, opts) => {
  const p = new URL(url).pathname;
  const params = Object.fromEntries(new URLSearchParams(opts.body || ""));
  stripeCalls.push({ path: p, params });
  const id =
    p === "/v1/checkout/sessions" ? "cs_test_" + crypto.randomBytes(6).toString("hex")
    : p === "/v1/accounts" ? "acct_test_" + crypto.randomBytes(6).toString("hex")
    : p === "/v1/transfers" ? "tr_test_" + crypto.randomBytes(6).toString("hex")
    : p === "/v1/refunds" ? "re_test_" + crypto.randomBytes(6).toString("hex")
    : "obj_test";
  const body =
    p === "/v1/checkout/sessions" ? { id, url: `https://checkout.stripe.com/c/pay/${id}` }
    : p === "/v1/account_links" ? { url: "https://connect.stripe.com/setup/e/test" }
    : { id };
  return { ok: true, status: 200, json: async () => body };
};

// ---------- fake mailer ----------
const mailbox = [];
const fakeMailer = {
  sendVerifyEmail: async (to, link) => { mailbox.push({ to, link }); },
  sendWebLoginEmail: async (to, link) => { mailbox.push({ to, link }); },
  sendAdvertiserReceiptEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendCampaignRejectedEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendGiftRedemptionEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendReferralInviteEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendCrewInviteEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendRedemptionConfirmationEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendReferralRewardEmail: async (to, details) => { mailbox.push({ to, ...details }); },
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required — e.g. docker compose up -d db");
    process.exit(1);
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ns = "bbtest_" + crypto.randomBytes(4).toString("hex");
  await pool.query(`create schema ${ns}`);
  // search_path set at connection startup so every pooled connection lands in ns
  const poolNs = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${ns}` });
  await poolNs.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));

  const config = {
    revenueShare: 0.9, dailyImpressionCap: 5000, ipDailyImpressionCap: 0, dailyClickCap: 5, payoutThresholdCents: 1000,
    referralRewardCents: 2000, referralCap: 10,
    affiliateRewardBps: 1000, affiliateCapPeople: 1000,
    stripeWebhookSecret: WEBHOOK_SECRET, siteUrl: "https://freeai.fyi",
    apiBaseUrl: "", corsOrigin: "https://freeai.fyi", adminKey: "test-admin",
    emailTokenTtlMs: 1800000, emailCooldownMs: 0, webSessionTtlMs: 2592000000, clickTokenTtlMs: 120000, maxBodyBytes: 65536,
    logRequests: false, giftFulfillmentEmail: "hello@contact.freeai.fyi",
  };
  const repo = createRepo(poolNs);
  const stripe = createStripe("sk_test_fake", { fetchImpl: fakeFetch });
  const bigLimiter = createRateLimiter({ capacity: 100000, refillPerSec: 100000 });
  const { server } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.apiBaseUrl = base; // handlers read config at request time

  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };

  let pass = 0;
  const check = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log("  ✓ " + name); });

  const payWebhook = async (campaignId, paymentIntent = "pi_test_" + crypto.randomBytes(4).toString("hex"), eventId = "evt_" + crypto.randomBytes(6).toString("hex")) => {
    const payload = JSON.stringify({
      id: eventId, type: "checkout.session.completed",
      data: { object: { metadata: { campaign_id: campaignId }, payment_intent: paymentIntent } },
    });
    return api("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET) });
  };
  const approve = (campaignId) => api("POST", "/v1/admin/campaigns/approve", { adminKey: "test-admin", campaignId });

  console.log("freeai api verification (real postgres, fake stripe + mail)\n");

  await check("healthz", async () => assert.strictEqual((await api("GET", "/healthz")).status, 200));

  await check("CORS preflight returns 204 with allow-origin", async () => {
    const r = await fetch(base + "/v1/ads", { method: "OPTIONS" });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), "https://freeai.fyi");
    // authed web endpoints send a Bearer token, so the preflight must allow it
    assert.ok(/authorization/i.test(r.headers.get("access-control-allow-headers")), "Authorization not in allowed headers");
  });

  // ---------- checkout + validation ----------
  let campA;
  await check("checkout creates pending campaign + Stripe session", async () => {
    const r = await api("POST", "/v1/checkout", {
      email: "ads@linear.app", adLine: "Linear — issue tracking built for speed",
      url: "https://linear.app/", brand: "Linear", pricePerBlock: 5, blocks: 2,
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.checkoutUrl.startsWith("https://checkout.stripe.com/"));
    campA = r.body.campaignId;
    const call = stripeCalls.find((c) => c.path === "/v1/checkout/sessions");
    assert.strictEqual(call.params["line_items[0][price_data][unit_amount]"], "500");
    assert.strictEqual(call.params["metadata[campaign_id]"], campA);
  });

  await check("checkout rejects sub-$0.50 bids and XSS ad lines", async () => {
    // $0.50 is the floor (Stripe USD minimum); anything below is rejected.
    assert.strictEqual((await api("POST", "/v1/checkout", { email: "a@b.co", adLine: "ok line", url: "https://x.com", pricePerBlock: 0.49, blocks: 1 })).status, 400);
    const xss = await api("POST", "/v1/checkout", { email: "a@b.co", adLine: '<script>alert(1)</script>', url: "https://x.com", pricePerBlock: 5, blocks: 1 });
    assert.strictEqual(xss.status, 400);
  });

  // ---------- payment -> review -> approve ----------
  await check("paid campaign waits in review (not served) until approved", async () => {
    let ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 0);
    const wh = await payWebhook(campA);
    assert.strictEqual(wh.status, 200);
    // the transitioning webhook emails the advertiser a receipt exactly once
    const receipt = mailbox.find((m) => m.campaignId === campA);
    assert.ok(receipt, "no advertiser receipt sent on payment");
    assert.strictEqual(receipt.to, "ads@linear.app");
    assert.strictEqual(receipt.blocks, 2);
    assert.strictEqual(receipt.pricePerBlockCents, 500);
    ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 0, "served before moderation");
    const queue = await api("GET", "/v1/admin/campaigns", undefined, { "X-Admin-Key": "test-admin" });
    assert.strictEqual(queue.body.campaigns.length, 1);
    await approve(campA);
    ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads[0].line, "Linear — issue tracking built for speed");
  });

  await check("webhook bad signature rejected; moderation needs admin key", async () => {
    const r = await api("POST", "/v1/webhooks/stripe", JSON.stringify({ id: "e", type: "x" }), { "stripe-signature": "t=1,v1=bad" });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await api("GET", "/v1/admin/campaigns?adminKey=nope")).status, 401);
  });

  await check("duplicate webhook event id is ignored (no double-funding)", async () => {
    const eid = "evt_dup_fixed";
    const r1 = await payWebhook(campA, "pi_x", eid); // campA already past pending_payment -> markCampaignPaid no-ops anyway
    const r2 = await payWebhook(campA, "pi_x", eid);
    assert.strictEqual(r2.body.duplicate, true);
    const credits = await poolNs.query(`select count(*)::int n from ledger where campaign_id = $1 and entry_type = 'campaign_credit'`, [campA]);
    assert.strictEqual(credits.rows[0].n, 1, "campA funded more than once");
  });

  // ---------- auction ranking ----------
  let campFluid;
  await check("auction ranks the higher bid first", async () => {
    const r = await api("POST", "/v1/checkout", {
      email: "ads@fluidstack.io", adLine: "Fluidstack — building 10GW of compute. Join us.",
      url: "https://fluidstack.io/", brand: "Fluidstack", pricePerBlock: 110, blocks: 2,
    });
    campFluid = r.body.campaignId;
    await payWebhook(campFluid);
    await approve(campFluid);
    const ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads[0].brand, "Fluidstack");
    assert.strictEqual((await api("GET", "/v1/leaderboard")).body.leaderboard[0].brand, "Fluidstack");
  });

  // ---------- devices & ledger ----------
  let device;
  await check("device registers and earns exactly 90% on impressions (events never bill self-reported clicks)", async () => {
    device = (await api("POST", "/v1/devices/register")).body;
    assert.ok(device.deviceId && device.deviceKey);
    // 100 impressions on campA ($5 block): 100*500/1000 = 50c -> 45c. The clicks
    // field is IGNORED for billing — genuine clicks go through the token path —
    // so a forged clicks count mints nothing.
    const r = await api("POST", "/v1/events", { ...device, batchKey: "b1", events: [{ campaignId: campA, impressions: 100, clicks: 9999 }] });
    assert.strictEqual(r.body.creditedMillicents, 45000);
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body.earnedUsd, 0.45);

    // a clicks-only batch credits nothing at all (and can't bypass the daily cap)
    const clicksOnly = await api("POST", "/v1/events", { ...device, batchKey: "b1-clicks", events: [{ campaignId: campA, impressions: 0, clicks: 100000 }] });
    assert.strictEqual(clicksOnly.body.creditedMillicents, 0);
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body.earnedUsd, 0.45);
  });

  await check("replayed batch never double-pays; bad creds 401; cap 429", async () => {
    assert.strictEqual((await api("POST", "/v1/events", { ...device, batchKey: "b1", events: [{ campaignId: campA, impressions: 100, clicks: 1 }] })).body.duplicate, true);
    assert.strictEqual((await api("POST", "/v1/events", { deviceId: device.deviceId, deviceKey: "wrong", batchKey: "z", events: [] })).status, 401);
    assert.strictEqual((await api("POST", "/v1/events", { ...device, batchKey: "bcap", events: [{ campaignId: campA, impressions: 6000, clicks: 0 }] })).status, 429);
  });

  // ---------- server-side clicks ----------
  let clickDevice;
  await check("click intent + /go redirect credits the device server-side", async () => {
    clickDevice = (await api("POST", "/v1/devices/register")).body;
    const intent = await api("POST", "/v1/clicks/intent", { ...clickDevice, campaignId: campFluid });
    assert.strictEqual(intent.status, 200);
    assert.ok(intent.body.trackingUrl.includes("/v1/go/"));
    const token = intent.body.trackingUrl.split("/v1/go/")[1];
    const go = await api("GET", `/v1/go/${token}`);
    assert.strictEqual(go.status, 302);
    assert.strictEqual(go.headers.get("location"), "https://fluidstack.io/");
    // billed 50 on $110 block: 11000*50/1000 = 550c -> 495c = 495000 mc
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${clickDevice.deviceId}&deviceKey=${clickDevice.deviceKey}`)).body.earnedUsd, 4.95);
    // single-use: replay redirects but pays nothing more
    await api("GET", `/v1/go/${token}`);
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${clickDevice.deviceId}&deviceKey=${clickDevice.deviceKey}`)).body.earnedUsd, 4.95);
  });

  await check("click intent for an inactive campaign is 404", async () => {
    assert.strictEqual((await api("POST", "/v1/clicks/intent", { ...clickDevice, campaignId: campA && "00000000-0000-0000-0000-000000000000" })).status, 404);
  });

  await check("verified clicks are capped per device per day (50x path can't be looped to drain a budget)", async () => {
    // dedicated, well-funded campaign so the cap (not the budget) is what bites
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@clickcap.co", adLine: "click cap regression campaign", url: "https://clickcap.example/",
      brand: "ClickCap", pricePerBlock: 2, blocks: 5,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const capDev = (await api("POST", "/v1/devices/register")).body;

    // fire 7 clicks; dailyClickCap is 5, so only 5 may credit
    for (let i = 0; i < 7; i++) {
      const intent = await api("POST", "/v1/clicks/intent", { ...capDev, campaignId: camp.body.campaignId });
      const go = await api("GET", `/v1/go/${intent.body.trackingUrl.split("/v1/go/")[1]}`);
      assert.strictEqual(go.status, 302); // over-cap clicks still redirect cleanly
      assert.strictEqual(go.headers.get("location"), "https://clickcap.example/");
    }
    // 5 clicks × ($2 block → 200mc × 50 = 10000mc gross × 90% = 9000mc) = 45000mc = $0.45
    const e = await api("GET", `/v1/me/earnings?deviceId=${capDev.deviceId}&deviceKey=${capDev.deviceKey}`);
    assert.strictEqual(e.body.earnedUsd, 0.45);
  });

  await check("concurrent gift redemptions can't double-spend the same balance", async () => {
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@race.co", adLine: "double spend regression campaign", url: "https://race.example/",
      brand: "Race", pricePerBlock: 110, blocks: 1,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);

    // earn $24.75 — enough for exactly one $20 Pro month, not two — then link
    // the device to an email and open a web session (redemption is web-only).
    const raceDev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...raceDev, batchKey: "brace", events: [{ campaignId: camp.body.campaignId, impressions: 250, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...raceDev, email: "race@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));
    await api("POST", "/v1/web/login", { email: "race@example.com" });
    const session = (await api("GET", mailbox.at(-1).link.replace(base, ""))).headers.get("location").match(/session=([^&]+)/)[1];
    const auth = { Authorization: `Bearer ${session}` };
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.balanceUsd, 24.75);

    // fire two identical redemptions at once: exactly one settles, the ledger never overdraws
    const [a, b] = await Promise.all([
      api("POST", "/v1/web/redemptions", { plan: "pro", months: 1, recipientEmail: "race@example.com" }, auth),
      api("POST", "/v1/web/redemptions", { plan: "pro", months: 1, recipientEmail: "race@example.com" }, auth),
    ]);
    // exactly one settles; the loser is rejected for insufficient credits —
    // at the pre-check (403) or the in-transaction recheck (409) depending on
    // scheduling. The invariant that matters: the balance is charged only once.
    const ok = [a, b].filter((r) => r.status === 200);
    const failed = [a, b].filter((r) => r.status !== 200);
    assert.strictEqual(ok.length, 1, "exactly one redemption should succeed");
    assert.ok([403, 409].includes(failed[0].status), "the loser is rejected for insufficient credits");
    const after = (await api("GET", "/v1/web/me", undefined, auth)).body;
    assert.strictEqual(after.balanceUsd, 4.75, "only one $20 gift was charged");
    assert.ok(after.balanceUsd >= 0, "balance never goes negative");
  });

  await check("per-IP daily impression cap bounds farming across many anonymous devices", async () => {
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@ipcap.co", adLine: "ip cap regression campaign", url: "https://ipcap.example/",
      brand: "IPCap", pricePerBlock: 5, blocks: 50,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);

    // second app instance with a low per-IP cap; all test traffic shares 127.0.0.1
    const cfgIp = { ...config, ipDailyImpressionCap: 1500 };
    const { server: s3 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgIp });
    await new Promise((r) => s3.listen(0, r));
    const b3 = `http://127.0.0.1:${s3.address().port}`;
    const post = (p, b) => fetch(b3 + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const d1 = (await post("/v1/devices/register", {})).body;
    const d2 = (await post("/v1/devices/register", {})).body;
    // d1 is under both caps and credits normally
    const r1 = await post("/v1/events", { ...d1, batchKey: "ip-a", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    assert.strictEqual(r1.status, 200);
    // d2 is well under ITS OWN device cap (5000) but tips the shared IP past 1500 → 429
    const r2 = await post("/v1/events", { ...d2, batchKey: "ip-b", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    assert.strictEqual(r2.status, 429);
    s3.close();
  });

  // ---------- email-gated payouts ----------
  await check("onboarding is blocked until email is verified", async () => {
    const blocked = await api("POST", "/v1/connect/onboard", device);
    assert.strictEqual(blocked.status, 403);

    const req = await api("POST", "/v1/auth/request-link", { ...device, email: "dev@example.com" });
    assert.strictEqual(req.status, 200);
    const link = mailbox.at(-1).link;
    const token = new URL(link).searchParams.get("token");
    const verify = await api("GET", `/v1/auth/verify?token=${token}`);
    assert.strictEqual(verify.status, 302);
    assert.strictEqual(verify.headers.get("location"), "https://freeai.fyi/?verified=1");

    const ok = await api("POST", "/v1/connect/onboard", device);
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.onboardingUrl.includes("connect.stripe.com"));
    const acct = stripeCalls.find((c) => c.path === "/v1/accounts");
    assert.strictEqual(acct.params.type, "express");
  });

  await check("account.updated enables payouts; sweep transfers whole cents", async () => {
    const accountId = (await poolNs.query("select stripe_account_id from users where email = 'dev@example.com'")).rows[0].stripe_account_id;
    const payload = JSON.stringify({ id: "evt_acct_1", type: "account.updated", data: { object: { id: accountId, charges_enabled: true, payouts_enabled: true } } });
    await api("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET) });

    // top device up well over $10: 1000 imps on the $110 campaign = $99
    await api("POST", "/v1/events", { ...device, batchKey: "bbig", events: [{ campaignId: campFluid, impressions: 1000, clicks: 0 }] });
    const before = (await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body;
    const expectedCents = Math.floor((before.balanceUsd * 100000) / 1000);

    const r = await api("POST", "/v1/admin/payouts", { adminKey: "test-admin" });
    assert.strictEqual(r.body.paid, 1);
    const transfer = stripeCalls.find((c) => c.path === "/v1/transfers");
    assert.strictEqual(transfer.params.amount, String(expectedCents));
    const after = (await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body;
    assert.strictEqual(Math.round(after.paidOutUsd * 100), expectedCents);
    assert.strictEqual((await api("POST", "/v1/admin/payouts", { adminKey: "nope" })).status, 401);
  });

  // ---------- gift card catalog + retired device redemption ----------
  await check("giftcards catalog lists plans; device-credential redemption is retired", async () => {
    const catalog = await api("GET", "/v1/giftcards");
    assert.strictEqual(catalog.body.plans.find((p) => p.id === "pro").monthlyUsd, 20);
    assert.deepStrictEqual(catalog.body.months, [1, 3, 6, 12]);

    // Redemption is a website-only, logged-in flow. The old device-credential
    // path is retired: even a valid deviceKey with a redeemable balance must not
    // be able to cash out — it gets a 410 and the balance is left untouched.
    const giftDevice = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...giftDevice, batchKey: "bgift", events: [{ campaignId: campFluid, impressions: 250, clicks: 0 }] });
    const before = (await api("GET", `/v1/me/earnings?deviceId=${giftDevice.deviceId}&deviceKey=${giftDevice.deviceKey}`)).body;
    assert.strictEqual(before.balanceUsd, 24.75);

    const r = await api("POST", "/v1/redemptions", { ...giftDevice, plan: "pro", months: 1, recipientEmail: "dev@example.com" });
    assert.strictEqual(r.status, 410, "device-credential redemption is retired");
    assert.match(r.body.redeemUrl, /\/redeem\.html$/);

    const after = (await api("GET", `/v1/me/earnings?deviceId=${giftDevice.deviceId}&deviceKey=${giftDevice.deviceKey}`)).body;
    assert.strictEqual(after.balanceUsd, 24.75, "balance untouched — no debit");
    assert.strictEqual(after.redeemedUsd, 0, "nothing redeemed via the retired path");
  });

  // ---------- website login + user-scoped redemption ----------
  await check("website login lets a user redeem their linked balance for a gift card", async () => {
    // dedicated campaign so this test's earnings are independent of others
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@web.co", adLine: "web test campaign line", url: "https://example.com/",
      brand: "WebTest", pricePerBlock: 110, blocks: 2,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);

    // device earns, then links its credits to an email via the magic link
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...dev, batchKey: "bweb", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...dev, email: "web@example.com" });
    const verifyLink = mailbox.at(-1).link;
    await api("GET", verifyLink.replace(base, ""));

    // web login: email a sign-in link, follow it to get a session
    const login = await api("POST", "/v1/web/login", { email: "web@example.com" });
    assert.strictEqual(login.status, 200);
    const loginLink = mailbox.at(-1).link;
    const sess = await api("GET", loginLink.replace(base, ""));
    assert.strictEqual(sess.status, 302);
    const session = sess.headers.get("location").match(/session=([^&]+)/)[1];

    // balance is visible and matches the device's earnings (1000 imp @ $110 block, 90%)
    const me = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.email, "web@example.com");
    assert.strictEqual(me.body.balanceUsd, 99);

    // redeem Claude Pro, 3 months = $60, leaving $39. A client-supplied
    // recipientEmail is IGNORED — the gift always goes to the account email,
    // so a stolen session can't redirect a cash-out to an attacker inbox.
    const r = await api("POST", "/v1/web/redemptions",
      { plan: "pro", months: 3, recipientEmail: "attacker@evil.com" },
      { Authorization: `Bearer ${session}` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.amountUsd, 60);
    assert.strictEqual(r.body.balanceUsd, 39);

    // The fulfillment inbox is notified; the redeeming user now also gets their
    // own confirmation, so find the fulfillment mail rather than the last one.
    const mail = [...mailbox].reverse().find((m) => m.to === "hello@contact.freeai.fyi");
    assert.ok(mail, "fulfillment inbox is notified of the redemption");
    assert.strictEqual(mail.planName, "Claude Pro");
    assert.strictEqual(mail.months, 3);
    assert.strictEqual(mail.recipientEmail, "web@example.com", "recipient is forced to the account email");
    assert.ok([...mailbox].reverse().find((m) => m.to === "web@example.com" && m.planName),
      "the redeeming user also gets a confirmation email");

    const after = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` });
    assert.strictEqual(after.body.balanceUsd, 39);

    // can't redeem beyond balance, and no session = 401
    const broke = await api("POST", "/v1/web/redemptions",
      { plan: "max5x", months: 1 }, { Authorization: `Bearer ${session}` });
    assert.strictEqual(broke.status, 403);
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "pro", months: 1 })).status, 401);

    // validation on the logged-in path: bad plan / months
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "ultra", months: 1 }, { Authorization: `Bearer ${session}` })).status, 400);
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "pro", months: 2 }, { Authorization: `Bearer ${session}` })).status, 400);

    // sign out revokes the session server-side: the same bearer token is dead
    const logout = await api("POST", "/v1/web/logout", {}, { Authorization: `Bearer ${session}` });
    assert.strictEqual(logout.status, 200);
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` })).status, 401);
  });

  await check("magic-link sends are rate-limited per email (anti-bomb / anti-enumeration)", async () => {
    // second app instance with a real cooldown; the main suite runs with it off
    const cfgCd = { ...config, emailCooldownMs: 60000 };
    const { server: s4 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgCd });
    await new Promise((r) => s4.listen(0, r));
    const b4 = `http://127.0.0.1:${s4.address().port}`;
    const post = (p, b) => fetch(b4 + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const before = mailbox.length;
    const r1 = await post("/v1/web/login", { email: "flood@example.com" });
    const r2 = await post("/v1/web/login", { email: "flood@example.com" });
    // both responses look identical to the caller — no enumeration signal …
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.ok(r2.body.sent, "throttled response shape is unchanged");
    // … but only one email actually went out within the cooldown window
    assert.strictEqual(mailbox.length - before, 1, "second rapid send is suppressed");
    s4.close();
  });

  // ---------- referrals ----------
  // follow a magic-link from the mailbox and return the web session token
  const loginVia = async (email, referralCode) => {
    await api("POST", "/v1/web/login", referralCode ? { email, referralCode } : { email });
    const link = mailbox.at(-1).link;
    const sess = await api("GET", link.replace(base, ""));
    return sess.headers.get("location").match(/session=([^&]+)/)[1];
  };
  const userId = async (email) =>
    (await poolNs.query("select id from users where email = $1", [email])).rows[0].id;

  await check("the $20 referral program is retired: signup no longer attributes, redemption pays no referrer", async () => {
    // referrer signs up and reads their (still-minted) shareable code
    const refSess = await loginVia("ref-er@example.com");
    const refDash = await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refDash.status, 200);
    const code = refDash.body.code;
    assert.ok(/^[A-Z0-9]{8}$/.test(code), "code is 8 chars");

    // friend signs up WITH the code → NO referral attribution (program retired):
    // no referrals row and no referred_by on the user.
    const friendSess = await loginVia("ref-ee@example.com", code);
    const friendId = await userId("ref-ee@example.com");
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from referrals where referred_user_id = $1", [friendId])).rows[0].n, 0,
      "no referral row is created at signup");
    assert.strictEqual(
      (await poolNs.query("select referred_by from users where id = $1", [friendId])).rows[0].referred_by, null,
      "referred_by is not set at signup");

    // friend earns >$20 on a linked device, then redeems their first gift card
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@ref.co", adLine: "referral funded campaign", url: "https://example.com/",
      brand: "RefCo", pricePerBlock: 110, blocks: 1,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...dev, batchKey: "bref", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...dev, email: "ref-ee@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));

    const red = await api("POST", "/v1/web/redemptions",
      { plan: "pro", months: 1, recipientEmail: "ref-ee@example.com" },
      { Authorization: `Bearer ${friendSess}` });
    assert.strictEqual(red.status, 200);

    // the referrer earns NOTHING — no referral_credit, balance unchanged
    const refMe = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refMe.body.balanceUsd, 0, "referrer is not paid — the $20 program is retired");
    assert.strictEqual(
      (await poolNs.query(
        "select count(*)::int n from ledger where entry_type = 'referral_credit' and user_id = $1",
        [await userId("ref-er@example.com")])).rows[0].n, 0,
      "no referral_credit ledger entry is ever posted");
  });

  await check("email invites: send + self-refer guard (retired program: no joined/rewarded transitions)", async () => {
    const inviterSess = await loginVia("inviter@example.com");

    // first-login onboarding gate: a brand-new user must refer someone before
    // the dashboard unlocks, so /v1/web/me reports needsReferral=true
    assert.strictEqual(
      (await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${inviterSess}` })).body.needsReferral,
      true, "new user needs to refer a friend first");

    // can't invite your own email
    const self = await api("POST", "/v1/web/affiliate/invite", { email: "inviter@example.com" },
      { Authorization: `Bearer ${inviterSess}` });
    assert.strictEqual(self.status, 400);

    // a failed self-invite doesn't clear the gate
    assert.strictEqual(
      (await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${inviterSess}` })).body.needsReferral,
      true, "rejected invite leaves the gate up");

    // a malformed address is rejected too
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate/invite", { email: "nope" }, { Authorization: `Bearer ${inviterSess}` })).status,
      400);

    // invite a friend to your crew → email goes out and the invite is recorded as 'sent'
    const inv = await api("POST", "/v1/web/affiliate/invite", { email: "invitee@example.com" },
      { Authorization: `Bearer ${inviterSess}` });
    assert.strictEqual(inv.status, 200);
    assert.strictEqual(inv.body.sent, true, "crew invite reports sent:true");
    assert.strictEqual(inv.body.invite.status, "sent");

    // a valid invite clears the onboarding gate — the friend needn't sign up
    assert.strictEqual(
      (await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${inviterSess}` })).body.needsReferral,
      false, "one valid crew invite unlocks the dashboard");

    // the crew invite went out via the crew-invite mailer (rewardPct, not $20)
    const invMail = mailbox.at(-1);
    assert.strictEqual(invMail.to, "invitee@example.com");
    assert.ok(invMail.rewardPct !== undefined, "crew invite uses sendCrewInviteEmail");
    // the invite link carries the inviter's affiliate code so the friend is
    // attributed to their crew
    const inviterCode = (await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${inviterSess}` })).body.code;
    assert.ok(invMail.link.includes(`ref=${inviterCode}`), "invite link carries the inviter's affiliate code");

    // dashboard now shows the invite under the 'invited' stage, with the email
    // masked so the page never leaks the full address
    let dash = await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${inviterSess}` });
    assert.strictEqual(dash.body.invitedCount, 1);
    const invitedItem = dash.body.referrals.find((r) => r.email === "i•••@example.com");
    assert.ok(invitedItem && invitedItem.status === "invited", "invitee listed as invited (masked)");
    assert.ok(!JSON.stringify(dash.body.referrals).includes("invitee@example.com"), "full email never leaves the server");

    // the $20 referral program is retired: signing up with the code no longer
    // attributes the friend, so the invite stays 'sent' (no 'joined' transition)
    // and no referrals row is created.
    await loginVia("invitee@example.com", inviterCode);
    assert.strictEqual(
      (await poolNs.query("select status from referral_invites where lower(email) = 'invitee@example.com'")).rows[0].status,
      "sent", "retired program: signup does not flip the invite to 'joined'");
    assert.strictEqual(
      (await poolNs.query("select referred_by from users where id = $1", [await userId("invitee@example.com")])).rows[0].referred_by,
      null, "retired program: signup does not attribute the friend");

    // and redeeming never advances the invite to 'rewarded' nor pays the inviter
    const inviteeId = await userId("invitee@example.com");
    await poolNs.query("insert into ledger (entry_type, amount_millicents, user_id) values ('impression_credit', 2000000, $1)", [inviteeId]);
    const inviteeSess = await loginVia("invitee@example.com");
    assert.strictEqual(
      (await api("POST", "/v1/web/redemptions", { plan: "pro", months: 1, recipientEmail: "invitee@example.com" },
        { Authorization: `Bearer ${inviteeSess}` })).status, 200);
    assert.strictEqual(
      (await poolNs.query("select status from referral_invites where lower(email) = 'invitee@example.com'")).rows[0].status,
      "sent", "retired program: redemption does not reward the inviter");
    assert.strictEqual(
      (await poolNs.query(
        "select count(*)::int n from ledger where entry_type = 'referral_credit' and user_id = $1",
        [await userId("inviter@example.com")])).rows[0].n, 0,
      "no referral_credit is posted");
    // the redeemer still gets the branded redemption confirmation; the retired
    // referrer is never emailed a bonus.
    assert.ok(mailbox.some((m) => m.to === "invitee@example.com" && m.planName),
      "redeemer receives a gift-card redemption confirmation");
    assert.ok(!mailbox.some((m) => m.to === "inviter@example.com" && m.rewardUsd > 0),
      "retired program: the inviter is not emailed any referral bonus");
  });

  // ---------- affiliates ----------
  await check("affiliate: self-serve 10% of an affiliated user's earnings (people cap, uncapped $); upgrade request attaches socials", async () => {
    const affSess = await loginVia("affiliate@example.com");

    // self-serve: every signed-in user is auto-enrolled with a code at the base 10%
    let dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${affSess}` });
    assert.strictEqual(dash.body.enrolled, true);
    const code = dash.body.code;
    assert.ok(/^[A-Z0-9]{8}$/.test(code), "affiliate code is 8 chars");
    assert.strictEqual(dash.body.link, `https://freeai.fyi/redeem.html?ref=${code}`);
    assert.strictEqual(dash.body.rewardPct, 10);
    assert.strictEqual(dash.body.upgraded, false);
    assert.strictEqual(dash.body.upgradeRequested, false);

    // influencer upgrade form validation: at least one handle, a follower count per handle
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate/apply", {}, { Authorization: `Bearer ${affSess}` })).status,
      400, "no handles rejected");
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate/apply", { instagram: "creator" }, { Authorization: `Bearer ${affSess}` })).status,
      400, "handle without a follower count rejected");

    // submitting socials requests the upgrade without disturbing the active base 10%
    const applied = await api("POST", "/v1/web/affiliate/apply",
      { instagram: "@creator", instagramFollowers: "120,000", twitter: "creator", twitterFollowers: 8000 },
      { Authorization: `Bearer ${affSess}` });
    assert.strictEqual(applied.status, 200);
    assert.strictEqual(applied.body.ok, true);

    dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${affSess}` });
    assert.strictEqual(dash.body.upgradeRequested, true, "socials attached → upgrade requested");
    assert.strictEqual(dash.body.upgraded, false, "still base 10% until an admin grants more");
    assert.strictEqual(dash.body.code, code, "code is unchanged by the upgrade request");

    // admin sees the affiliate with parsed socials
    const list = await api("GET", "/v1/admin/affiliates", undefined, { "X-Admin-Key": "test-admin" });
    const appRow = list.body.affiliates.find((a) => a.email === "affiliate@example.com");
    assert.ok(appRow && appRow.status === "approved");
    assert.strictEqual(appRow.instagram_followers, 120000, "comma-formatted follower count parsed");
    const affId = appRow.id;

    // a new user signs up WITH the affiliate code → attributed to the affiliate,
    // and that attribution is mutually exclusive with referrals (no referred_by)
    const userSess = await loginVia("affuser@example.com", code);
    const affUserId = await userId("affuser@example.com");
    const urow = (await poolNs.query("select affiliate_id, referred_by from users where id = $1", [affUserId])).rows[0];
    assert.strictEqual(urow.affiliate_id, affId);
    assert.strictEqual(urow.referred_by, null, "affiliate and referral attribution are mutually exclusive");
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from affiliate_attributions where affiliated_user_id = $1", [affUserId])).rows[0].n,
      1);

    // the affiliated user earns on a linked device → the affiliate accrues 10%.
    // The device must be linked before earning, since accrual happens at ingest.
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@aff.co", adLine: "affiliate funded campaign", url: "https://example.com/",
      brand: "AffCo", pricePerBlock: 5, blocks: 5,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/auth/request-link", { ...dev, email: "affuser@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));
    await api("POST", "/v1/events", { ...dev, batchKey: "baff", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });

    // dev keeps 90% ($4.50); affiliate earns 10% of that dev credit ($0.45)
    assert.strictEqual((await repo.balanceForUser(affUserId)).balanceMillicents, 450000, "affiliated user keeps 100% of their earnings");
    assert.strictEqual(
      (await repo.balanceForUser(await userId("affiliate@example.com"))).balanceMillicents, 45000,
      "affiliate earns 10% as a platform-funded bonus");

    // people cap: lower this affiliate's cap to 1 (they already have 1 attributed
    // friend). A second distinct user signing up with the code is NOT attributed.
    await poolNs.query("update affiliates set cap_people = 1 where id = $1", [affId]);
    await loginVia("affuser2@example.com", code);
    const affUser2Id = await userId("affuser2@example.com");
    assert.strictEqual(
      (await poolNs.query("select affiliate_id from users where id = $1", [affUser2Id])).rows[0].affiliate_id, null,
      "second user past the people cap is not attributed");
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from affiliate_attributions where affiliate_id = $1", [affId])).rows[0].n, 1,
      "no new attribution row past the people cap");

    // dollar earnings are UNCAPPED: set the affiliate's legacy dollar cap to a low
    // value (the old code would have clamped affiliate credits here) and prove the
    // affiliate now keeps accruing 10% straight past it with no ceiling.
    await poolNs.query("update affiliates set cap_millicents = 50000 where id = $1", [affId]);
    // 3 more batches of 1000 impressions → affiliate +45000 millicents each.
    for (let i = 0; i < 3; i++) {
      await api("POST", "/v1/events", { ...dev, batchKey: `bafflong${i}`, events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    }
    // started at 45000 millicents; +45000 per batch × 3 = 180000 total.
    const affBal = (await repo.balanceForUser(await userId("affiliate@example.com"))).balanceMillicents;
    assert.strictEqual(affBal, 45000 + 45000 * 3, "affiliate keeps accruing 10% with no dollar ceiling");
    assert.ok(affBal > 50000, "affiliate balance grows past the legacy dollar cap that used to clamp it");
  });

  await check("admin grants an influencer upgrade: custom rate, uncapped people cap, vanity code", async () => {
    const sess = await loginVia("creator@example.com");
    // starts on the self-serve base tier
    let dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(dash.body.rewardPct, 10);
    assert.strictEqual(dash.body.upgraded, false);

    const adminList = (await api("GET", "/v1/admin/affiliates", undefined, { "X-Admin-Key": "test-admin" })).body.affiliates;
    const row = adminList.find((a) => a.email === "creator@example.com");
    const takenCode = adminList.find((a) => a.email === "affiliate@example.com")?.code;

    // validation: rate out of range, and a code another affiliate already owns
    assert.strictEqual(
      (await api("POST", "/v1/admin/affiliates/grant", { affiliateId: row.id, rewardBps: 0, capPeople: 0 }, { "X-Admin-Key": "test-admin" })).status,
      400, "rewardBps must be ≥ 1");
    if (takenCode) assert.strictEqual(
      (await api("POST", "/v1/admin/affiliates/grant", { affiliateId: row.id, rewardBps: 2500, capPeople: 1000000000, code: takenCode }, { "X-Admin-Key": "test-admin" })).status,
      400, "can't take a code another affiliate already owns");

    // grant 25%, uncapped (huge people cap), with a vanity code (case-normalised)
    const granted = await api("POST", "/v1/admin/affiliates/grant",
      { affiliateId: row.id, rewardBps: 2500, capPeople: 1000000000, code: "creator1" },
      { "X-Admin-Key": "test-admin" });
    assert.strictEqual(granted.status, 200);
    assert.strictEqual(granted.body.affiliate.code, "CREATOR1", "vanity code is upper-cased");

    dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(dash.body.rewardPct, 25, "custom rate is live");
    assert.strictEqual(dash.body.upgraded, true);
    assert.strictEqual(dash.body.code, "CREATOR1", "vanity code is the affiliate's link");
    assert.ok(dash.body.capPeople >= 100000, "people cap is effectively unlimited");
  });

  await check("extension auto-links a device to the signed-in web account (no magic link)", async () => {
    const dev = (await api("POST", "/v1/devices/register")).body;
    const sess = await loginVia("linkme@example.com");
    // bad device creds and bad session are both rejected
    assert.strictEqual(
      (await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: "wrong", session: sess })).status,
      401, "bad device creds rejected");
    assert.strictEqual(
      (await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, session: "bogus" })).status,
      401, "bad web session rejected");
    // valid creds + session links the device to the user
    assert.strictEqual(
      (await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, session: sess })).status,
      200);
    const uid = await userId("linkme@example.com");
    assert.strictEqual(
      (await poolNs.query("select user_id from devices where id = $1", [dev.deviceId])).rows[0].user_id, uid,
      "device now belongs to the web user");
    // and the device-scoped crew endpoint now reports linked, with a code
    const aff = await api("GET", `/v1/me/affiliate?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`);
    assert.strictEqual(aff.body.linked, true);
    assert.ok(/^[A-Z0-9]{8}$/.test(aff.body.code), "linked device is auto-enrolled with an affiliate code");
    assert.strictEqual(aff.body.crewSize, 5, "crew exposes its 5-slot size");
    assert.deepStrictEqual(aff.body.invited, [], "no pending invites yet");
  });

  await check("crew invite: device-scoped, emails the affiliate link, fills a slot, guards bad input", async () => {
    const dev = (await api("POST", "/v1/devices/register")).body;
    const sess = await loginVia("crewboss@example.com");
    await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, session: sess });
    const code = (await api("GET", `/v1/me/affiliate?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body.code;

    // bad device creds are rejected; an unlinked device can't invite
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: "wrong", email: "f@x.com" })).status,
      401, "bad device creds rejected");
    const stranger = (await api("POST", "/v1/devices/register")).body;
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: stranger.deviceId, deviceKey: stranger.deviceKey, email: "f@x.com" })).status,
      401, "unlinked device can't invite");

    // a malformed email and inviting yourself are both rejected
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: "nope" })).status,
      400, "malformed email rejected");
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: "crewboss@example.com" })).status,
      400, "can't invite your own email");

    // a valid invite sends the affiliate-link email and records the invite
    mailbox.length = 0;
    const inv = await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: "crewmate@example.com" });
    assert.strictEqual(inv.status, 200);
    assert.strictEqual(inv.body.invite.status, "sent");
    const mail = mailbox.find((m) => m.to === "crewmate@example.com");
    assert.ok(mail && mail.link.includes(`ref=${code}`), "invite email carries the affiliate code link");

    // the pending invite now fills a crew slot (masked), still open slots remain
    const crew = (await api("GET", `/v1/me/affiliate?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body;
    assert.strictEqual(crew.invited.length, 1, "pending invite occupies a slot");
    assert.strictEqual(crew.invited[0].email, "c•••@example.com", "invited email is masked");
    assert.ok(!JSON.stringify(crew.invited).includes("crewmate@example.com"), "full email never leaves the server");
  });

  await check("affiliate codes apply retroactively; self/unknown codes rejected (referral program retired)", async () => {
    const affSess = await loginVia("aff2@example.com");
    // self-serve enrollment mints the code straight away (no application/approval)
    const code = (await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${affSess}` })).body.code;
    const row = (await api("GET", "/v1/admin/affiliates", undefined, { "X-Admin-Key": "test-admin" }))
      .body.affiliates.find((a) => a.email === "aff2@example.com");

    // an existing user with no attribution attaches the code retroactively
    const lateSess = await loginVia("late@example.com");
    assert.strictEqual((await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${lateSess}` })).status, 200);
    assert.strictEqual(
      (await poolNs.query("select affiliate_id from users where id = $1", [await userId("late@example.com")])).rows[0].affiliate_id,
      row.id);
    // re-applying once attributed is rejected
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${lateSess}` })).body.reason,
      "already_affiliated");

    // the $20 referral program is retired: signing up with a (referral) code no
    // longer sets referred_by, so such a user is NOT blocked — they can attach an
    // affiliate code like any other unattributed user.
    const refSess = await loginVia("refholder@example.com");
    const refCode = (await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${refSess}` })).body.code;
    const referredSess = await loginVia("referred-then-aff@example.com", refCode);
    assert.strictEqual(
      (await poolNs.query("select referred_by from users where id = $1", [await userId("referred-then-aff@example.com")])).rows[0].referred_by,
      null, "retired program: no referrer is set at signup");
    const applied = await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${referredSess}` });
    assert.strictEqual(applied.status, 200, "an unattributed user can attach an affiliate code");

    // an affiliate can't self-apply their own code, and unknown codes are rejected
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${affSess}` })).body.reason,
      "invalid_code", "can't self-apply your own affiliate code");
    const freshSess = await loginVia("fresh-aff@example.com");
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate-code", { code: "ZZZZZZZZ" }, { Authorization: `Bearer ${freshSess}` })).body.reason,
      "invalid_code");
  });

  await check("first-login survey: gates the dashboard, validates input, persists answers", async () => {
    const sess = await loginVia("survey@example.com");
    const auth = { Authorization: `Bearer ${sess}` };

    // a brand-new user must complete the survey before anything else
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.needsSurvey, true);

    // empty / unknown-only selections are rejected, and the gate stays up
    assert.strictEqual((await api("POST", "/v1/web/onboarding/survey", {}, auth)).status, 400);
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/survey", { models: ["bogus"], surfaces: ["nope"] }, auth)).status, 400);
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/survey", { models: ["claude"], surfaces: [] }, auth)).status, 400);
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.needsSurvey, true);

    // a valid multi-select submission clears the gate and stores the answers,
    // filtering unknown values and keeping the free-text "other" surface
    const ok = await api("POST", "/v1/web/onboarding/survey",
      { models: ["claude", "chatgpt", "bogus"], surfaces: ["browser_chrome", "other"], surfaceOther: "Raycast" }, auth);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.needsSurvey, false);

    const uid = await userId("survey@example.com");
    const row = (await poolNs.query("select models, surfaces, surface_other from onboarding_surveys where user_id = $1", [uid])).rows[0];
    assert.deepStrictEqual(row.models, ["claude", "chatgpt"], "unknown model filtered out");
    assert.deepStrictEqual(row.surfaces, ["browser_chrome", "other"]);
    assert.strictEqual(row.surface_other, "Raycast");

    // re-answering overwrites (idempotent upsert) and drops the now-irrelevant
    // free text when "other" is no longer selected
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/survey", { models: ["gemini"], surfaces: ["terminal"], surfaceOther: "ignored" }, auth)).status, 200);
    const row2 = (await poolNs.query("select models, surfaces, surface_other from onboarding_surveys where user_id = $1", [uid])).rows[0];
    assert.deepStrictEqual(row2.models, ["gemini"]);
    assert.deepStrictEqual(row2.surfaces, ["terminal"]);
    assert.strictEqual(row2.surface_other, null, "surface_other cleared when 'other' not selected");
  });

  // ---------- earnings dashboard + activity ledger ----------
  await check("web earnings endpoint reports today / month / lifetime and a chart series", async () => {
    const sess = await loginVia("earn@example.com");
    const uid = await userId("earn@example.com");

    // seed credits at known times: today, earlier this month, and last month.
    // last-month must be in this user's *month* window only if same month — pick
    // a date guaranteed to be a prior month via interval math so the test is
    // stable regardless of when it runs.
    await poolNs.query(
      `insert into ledger (entry_type, amount_millicents, user_id, created_at) values
         ('impression_credit', 1000000, $1, now()),
         ('click_credit',       500000, $1, date_trunc('month', now())),
         ('referral_credit',   2000000, $1, date_trunc('month', now()) - interval '5 days')`,
      [uid]);

    const e = await api("GET", "/v1/web/earnings?window=30d", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(e.status, 200);
    // today = the now() impression only ($10.00)
    assert.strictEqual(e.body.todayUsd, 10);
    // month-to-date = impression (now) + click (start of month) = $15.00
    assert.strictEqual(e.body.monthUsd, 15);
    // lifetime = all three credits = $35.00
    assert.strictEqual(e.body.lifetimeUsd, 35);
    assert.strictEqual(e.body.window, "30d");
    assert.ok(Array.isArray(e.body.series));
    // at least the now() bucket carries credit within the 30d window
    assert.ok(e.body.series.some((b) => b.usd > 0), "series has a non-zero bucket");

    // window defaults to 7d and switches bucket granularity
    const def = await api("GET", "/v1/web/earnings", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(def.body.window, "7d");
    assert.strictEqual((await api("GET", "/v1/web/earnings")).status, 401);
  });

  await check("web activity ledger lists credited events newest-first, excluding debits", async () => {
    const sess = await loginVia("act@example.com");
    const uid = await userId("act@example.com");
    await poolNs.query(
      `insert into ledger (entry_type, amount_millicents, user_id, created_at) values
         ('impression_credit', 1000000, $1, now() - interval '2 hours'),
         ('referral_credit',   2000000, $1, now() - interval '1 hour'),
         ('gift_redemption_debit', -500000, $1, now())`,
      [uid]);

    const act = await api("GET", "/v1/web/activity", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(act.status, 200);
    assert.strictEqual(act.body.count, 2, "only the two credits, not the debit");
    assert.strictEqual(act.body.rows[0].type, "referral_credit", "newest first");
    assert.strictEqual(act.body.rows[0].amountUsd, 20);
    assert.strictEqual(act.body.rows[1].type, "impression_credit");
    assert.ok(act.body.rows.every((r) => r.type !== "gift_redemption_debit"));
    assert.strictEqual((await api("GET", "/v1/web/activity")).status, 401);
  });

  // ---------- ad-surface waitlists ----------
  await check("web waitlist lets a signed-in user join ad-surface waitlists (idempotent, per-surface)", async () => {
    const sess = await loginVia("wait@example.com");
    const uid = await userId("wait@example.com");

    // catalog lists the four seeded surfaces, none joined yet
    const cat = await api("GET", "/v1/web/waitlist", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(cat.status, 200);
    assert.strictEqual(cat.body.surfaces.length, 4);
    assert.ok(cat.body.surfaces.every((s) => s.joined === false));
    assert.strictEqual(cat.body.surfaces[0].surface, "desktop", "sorted by sort_order");

    // join two surfaces
    const j1 = await api("POST", "/v1/web/waitlist", { surface: "desktop" }, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(j1.status, 200);
    assert.strictEqual(j1.body.joined, true);
    assert.strictEqual(j1.body.alreadyJoined, false);
    await api("POST", "/v1/web/waitlist", { surface: "vscode_extension" }, { Authorization: `Bearer ${sess}` });

    // re-joining a surface is a no-op (no duplicate row)
    const dup = await api("POST", "/v1/web/waitlist", { surface: "desktop" }, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(dup.body.alreadyJoined, true);
    const rows = (await poolNs.query("select surface from waitlist_signups where user_id = $1 order by surface", [uid])).rows;
    assert.deepStrictEqual(rows.map((r) => r.surface), ["desktop", "vscode_extension"]);

    // catalog now reflects the joined state
    const cat2 = await api("GET", "/v1/web/waitlist", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(cat2.body.surfaces.filter((s) => s.joined).length, 2);

    // unknown surface is rejected; missing session is 401
    assert.strictEqual((await api("POST", "/v1/web/waitlist", { surface: "smoke-signals" }, { Authorization: `Bearer ${sess}` })).status, 400);
    assert.strictEqual((await api("GET", "/v1/web/waitlist")).status, 401);
    assert.strictEqual((await api("POST", "/v1/web/waitlist", { surface: "desktop" })).status, 401);
  });

  // ---------- rejection + refund ----------
  await check("rejecting a reviewed campaign refunds via Stripe and posts a refund entry", async () => {
    const r = await api("POST", "/v1/checkout", { email: "spam@x.io", adLine: "questionable ad copy here", url: "https://x.io/", brand: "X", pricePerBlock: 3, blocks: 1 });
    await payWebhook(r.body.campaignId, "pi_reject_1");
    const rej = await api("POST", "/v1/admin/campaigns/reject", { adminKey: "test-admin", campaignId: r.body.campaignId, note: "off-policy" });
    assert.strictEqual(rej.body.refunded, true);
    assert.ok(stripeCalls.find((c) => c.path === "/v1/refunds" && c.params.payment_intent === "pi_reject_1"));
    const st = (await poolNs.query("select status from campaigns where id = $1", [r.body.campaignId])).rows[0].status;
    assert.strictEqual(st, "rejected");
    const refundEntry = await poolNs.query("select count(*)::int n from ledger where campaign_id = $1 and entry_type = 'campaign_refund'", [r.body.campaignId]);
    assert.strictEqual(refundEntry.rows[0].n, 1);
    // the advertiser is emailed about the rejection + refund, with the note
    const rejMail = mailbox.find((m) => m.campaignId === r.body.campaignId && m.note === "off-policy");
    assert.ok(rejMail, "no rejection email sent");
    assert.strictEqual(rejMail.to, "spam@x.io");
  });

  // ---------- XSS escaping on the admin page ----------
  await check("admin moderation page escapes untrusted text", async () => {
    // brand isn't charset-validated at intake, so prove the render path escapes it
    const adv = (await poolNs.query("insert into advertisers (email) values ('x@x.io') returning id")).rows[0].id;
    await poolNs.query(
      `insert into campaigns (advertiser_id, brand, ad_line, url, category, price_per_block_cents, blocks, impressions_total, impressions_remaining, status, paid_at)
       values ($1, $2, 'clean ad line', 'https://x.io/', 'other', 100, 1, 1000, 1000, 'pending_review', now())`,
      [adv, '<img src=x onerror=alert(1)>']);
    const page = await api("GET", "/admin?adminKey=test-admin");
    assert.ok(page.text.includes("&lt;img src=x onerror=alert(1)&gt;"), "brand not escaped");
    assert.ok(!page.text.includes("<img src=x onerror=alert(1)>"), "raw payload present");
    assert.strictEqual((await api("GET", "/admin?adminKey=wrong")).status, 401);
  });

  // ---------- killswitch ----------
  await check("killswitch stops ad serving and flips /v1/config", async () => {
    assert.strictEqual((await api("GET", "/v1/config")).body.serving, true);
    assert.ok((await api("GET", "/v1/ads")).body.ads.length > 0);
    assert.strictEqual((await api("POST", "/v1/admin/killswitch", { adminKey: "nope", serving: false })).status, 401);
    await api("POST", "/v1/admin/killswitch", { adminKey: "test-admin", serving: false });
    assert.strictEqual((await api("GET", "/v1/config")).body.serving, false);
    assert.strictEqual((await api("GET", "/v1/ads")).body.ads.length, 0, "ads served while killed");
    await api("POST", "/v1/admin/killswitch", { adminKey: "test-admin", serving: true });
    assert.ok((await api("GET", "/v1/ads")).body.ads.length > 0, "serving did not resume");
  });

  // ---------- ops guards: body cap + rate limit ----------
  await check("oversized request body returns 413", async () => {
    const huge = JSON.stringify({ blob: "x".repeat(70000) });
    const r = await api("POST", "/v1/checkout", huge);
    assert.strictEqual(r.status, 413);
  });

  await check("rate limiter returns 429 past capacity", async () => {
    const small = createRateLimiter({ capacity: 3, refillPerSec: 0 });
    const { server: s2 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: small, config });
    await new Promise((r) => s2.listen(0, r));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(b2 + "/healthz")).status);
    s2.close();
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
  });

  // ---------- cleanup ----------
  server.close();
  await poolNs.end();
  await pool.query(`drop schema ${ns} cascade`);
  await pool.end();
  console.log(`\nall ${pass} checks passed — paid, moderated, deduped, escaped, and 90% to the dev. 🤑`);
})().catch((err) => {
  console.error("\n✗ FAILED:", err.stack || err.message);
  process.exit(1);
});
