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
  sendGiftRedemptionEmail: async (to, details) => { mailbox.push({ to, ...details }); },
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
    revenueShare: 0.9, dailyImpressionCap: 5000, payoutThresholdCents: 1000,
    referralRewardCents: 2000, referralCap: 10,
    stripeWebhookSecret: WEBHOOK_SECRET, siteUrl: "https://freeai.fyi",
    apiBaseUrl: "", corsOrigin: "https://freeai.fyi", adminKey: "test-admin",
    emailTokenTtlMs: 1800000, webSessionTtlMs: 2592000000, clickTokenTtlMs: 120000, maxBodyBytes: 65536,
    logRequests: false, giftFulfillmentEmail: "conor.p43@gmail.com",
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

  await check("checkout rejects sub-$1 bids and XSS ad lines", async () => {
    assert.strictEqual((await api("POST", "/v1/checkout", { email: "a@b.co", adLine: "ok line", url: "https://x.com", pricePerBlock: 0.5, blocks: 1 })).status, 400);
    const xss = await api("POST", "/v1/checkout", { email: "a@b.co", adLine: '<script>alert(1)</script>', url: "https://x.com", pricePerBlock: 5, blocks: 1 });
    assert.strictEqual(xss.status, 400);
  });

  // ---------- payment -> review -> approve ----------
  await check("paid campaign waits in review (not served) until approved", async () => {
    let ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 0);
    const wh = await payWebhook(campA);
    assert.strictEqual(wh.status, 200);
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
  await check("device registers and earns exactly 90% (click = 50x)", async () => {
    device = (await api("POST", "/v1/devices/register")).body;
    assert.ok(device.deviceId && device.deviceKey);
    // 100 impressions + 1 click on campA ($5 block): (100 + 50)*500/1000 = 75c -> 67.5c
    const r = await api("POST", "/v1/events", { ...device, batchKey: "b1", events: [{ campaignId: campA, impressions: 100, clicks: 1 }] });
    assert.strictEqual(r.body.creditedMillicents, 67500);
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body.earnedUsd, 0.675);
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

  // ---------- gift card redemptions ----------
  await check("gift card redemption emails fulfillment and deducts the balance", async () => {
    const giftDevice = (await api("POST", "/v1/devices/register")).body;
    // 250 impressions on the $110 block: 250 * 11000mc gross -> 90% = $24.75
    await api("POST", "/v1/events", { ...giftDevice, batchKey: "bgift", events: [{ campaignId: campFluid, impressions: 250, clicks: 0 }] });
    const before = (await api("GET", `/v1/me/earnings?deviceId=${giftDevice.deviceId}&deviceKey=${giftDevice.deviceKey}`)).body;
    assert.strictEqual(before.balanceUsd, 24.75);

    const catalog = await api("GET", "/v1/giftcards");
    assert.strictEqual(catalog.body.plans.find((p) => p.id === "pro").monthlyUsd, 20);
    assert.deepStrictEqual(catalog.body.months, [1, 3, 6, 12]);

    const r = await api("POST", "/v1/redemptions", { ...giftDevice, plan: "pro", months: 1, recipientEmail: "dev@example.com" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.amountUsd, 20);
    assert.strictEqual(r.body.balanceUsd, 4.75);

    const mail = mailbox.at(-1);
    assert.strictEqual(mail.to, "conor.p43@gmail.com");
    assert.strictEqual(mail.planName, "Claude Pro");
    assert.strictEqual(mail.recipientEmail, "dev@example.com");
    assert.strictEqual(mail.redemptionId, r.body.redemptionId);

    const row = (await poolNs.query("select * from gift_redemptions where id = $1", [r.body.redemptionId])).rows[0];
    assert.strictEqual(row.amount_cents, 2000);
    assert.strictEqual(row.status, "pending");
    const after = (await api("GET", `/v1/me/earnings?deviceId=${giftDevice.deviceId}&deviceKey=${giftDevice.deviceKey}`)).body;
    assert.strictEqual(after.balanceUsd, 4.75);
    assert.strictEqual(after.redeemedUsd, 20);

    // not enough left for another Pro month
    const broke = await api("POST", "/v1/redemptions", { ...giftDevice, plan: "pro", months: 1, recipientEmail: "dev@example.com" });
    assert.strictEqual(broke.status, 403);
    assert.strictEqual(broke.body.error, "insufficient credits");

    // validation: bad plan/months/email and bad creds
    assert.strictEqual((await api("POST", "/v1/redemptions", { ...giftDevice, plan: "ultra", months: 1, recipientEmail: "a@b.co" })).status, 400);
    assert.strictEqual((await api("POST", "/v1/redemptions", { ...giftDevice, plan: "pro", months: 2, recipientEmail: "a@b.co" })).status, 400);
    assert.strictEqual((await api("POST", "/v1/redemptions", { ...giftDevice, plan: "pro", months: 1, recipientEmail: "nope" })).status, 400);
    assert.strictEqual((await api("POST", "/v1/redemptions", { deviceId: giftDevice.deviceId, deviceKey: "wrong", plan: "pro", months: 1 })).status, 401);
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

    // redeem Claude Pro, 3 months = $60, leaving $39
    const r = await api("POST", "/v1/web/redemptions",
      { plan: "pro", months: 3, recipientEmail: "gift@example.com" },
      { Authorization: `Bearer ${session}` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.amountUsd, 60);
    assert.strictEqual(r.body.balanceUsd, 39);

    const mail = mailbox.at(-1);
    assert.strictEqual(mail.to, "conor.p43@gmail.com");
    assert.strictEqual(mail.planName, "Claude Pro");
    assert.strictEqual(mail.months, 3);
    assert.strictEqual(mail.recipientEmail, "gift@example.com");

    const after = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` });
    assert.strictEqual(after.body.balanceUsd, 39);

    // can't redeem beyond balance, and no session = 401
    const broke = await api("POST", "/v1/web/redemptions",
      { plan: "max5x", months: 1 }, { Authorization: `Bearer ${session}` });
    assert.strictEqual(broke.status, 403);
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "pro", months: 1 })).status, 401);
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

  await check("referrer earns $20 once a referred friend redeems (single-sided, once, capped)", async () => {
    // referrer signs up and reads their shareable code
    const refSess = await loginVia("ref-er@example.com");
    const refDash = await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refDash.status, 200);
    const code = refDash.body.code;
    assert.ok(/^[A-Z0-9]{8}$/.test(code), "code is 8 chars");
    assert.strictEqual(refDash.body.link, `https://freeai.fyi/redeem.html?ref=${code}`);

    // friend signs up WITH the code → one pending referral, attributed to referrer
    const friendSess = await loginVia("ref-ee@example.com", code);
    const friendId = await userId("ref-ee@example.com");
    let row = (await poolNs.query("select referrer_user_id, status from referrals where referred_user_id = $1", [friendId])).rows;
    assert.strictEqual(row.length, 1);
    assert.strictEqual(row[0].status, "pending");
    assert.strictEqual(row[0].referrer_user_id, await userId("ref-er@example.com"));

    // a code can only be applied at first sign-in: a second login is a no-op
    await loginVia("ref-ee@example.com", code);
    const cnt = (await poolNs.query("select count(*)::int n from referrals where referred_user_id = $1", [friendId])).rows[0].n;
    assert.strictEqual(cnt, 1);

    // before the friend redeems, the referrer has earned nothing
    let refMe = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refMe.body.balanceUsd, 0);

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

    // referral is now rewarded and the referrer holds $20 of spendable credit
    row = (await poolNs.query("select status, reward_millicents from referrals where referred_user_id = $1", [friendId])).rows;
    assert.strictEqual(row[0].status, "rewarded");
    assert.strictEqual(Number(row[0].reward_millicents), 2000000);
    refMe = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refMe.body.balanceUsd, 20);
    const after = await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(after.body.rewardedCount, 1);
    assert.strictEqual(after.body.creditsEarnedUsd, 20);

    // idempotent: a second redemption by the friend does not double-credit
    const red2 = await api("POST", "/v1/web/redemptions",
      { plan: "pro", months: 1, recipientEmail: "ref-ee@example.com" },
      { Authorization: `Bearer ${friendSess}` });
    assert.strictEqual(red2.status, 200);
    refMe = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refMe.body.balanceUsd, 20);

    // cap: at the limit, a qualified redemption is marked 'capped' and pays nothing
    const capSess = await loginVia("cap-er@example.com");
    const capCode = (await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${capSess}` })).body.code;
    await loginVia("cap-ee@example.com", capCode);
    const capFriendId = await userId("cap-ee@example.com");
    await poolNs.query("insert into ledger (entry_type, amount_millicents, user_id) values ('impression_credit', 2000000, $1)", [capFriendId]);
    const rid = await repo.recordGiftRedemptionForUser({
      userId: capFriendId, plan: "pro", months: 1, amountCents: 2000, recipientEmail: "cap-ee@example.com",
      referralRewardMillicents: 2000000, referralCap: 0,
    });
    assert.ok(rid);
    const capStatus = (await poolNs.query("select status from referrals where referred_user_id = $1", [capFriendId])).rows[0].status;
    assert.strictEqual(capStatus, "capped");
    const capRefBal = await repo.balanceForUser(await userId("cap-er@example.com"));
    assert.strictEqual(capRefBal.balanceMillicents, 0);
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
