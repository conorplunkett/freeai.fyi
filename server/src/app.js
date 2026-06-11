// Betterbacks API — plain node:http, no framework.
// Everything is dependency-injected ({ repo, stripe, config }) so the test
// harness can run the real routes against a real database with a fake Stripe
// transport.
//
// Routes:
//   GET  /healthz                    liveness
//   GET  /v1/ads                     auction-ranked active ads (extension pulls this)
//   GET  /v1/leaderboard             public bid market (site pulls this)
//   POST /v1/devices/register        -> { deviceId, deviceKey }
//   POST /v1/events                  batched impressions/clicks from a device
//   POST /v1/checkout                advertiser -> Stripe Checkout URL
//   POST /v1/webhooks/stripe         checkout.session.completed, account.updated
//   POST /v1/connect/onboard         developer -> Stripe Express onboarding URL
//   GET  /v1/me/earnings             device-authenticated earnings
//   POST /v1/admin/payouts           run the payout sweep (admin key)

const http = require("node:http");
const crypto = require("node:crypto");
const { verifyWebhookSignature } = require("./stripe");
const { runPayouts } = require("./payouts");

function createApp({ repo, stripe, config }) {
  const routes = new Map();
  const route = (method, path, handler) => routes.set(`${method} ${path}`, handler);

  const json = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  };

  async function authDeviceFrom(body, query) {
    const deviceId = body?.deviceId || query?.get("deviceId");
    const deviceKey = body?.deviceKey || query?.get("deviceKey");
    return repo.authDevice(deviceId, deviceKey);
  }

  // ---------- ads & leaderboard ----------
  route("GET", "/healthz", async (req, res) => json(res, 200, { ok: true }));

  route("GET", "/v1/ads", async (req, res) => {
    const ads = await repo.activeAds();
    json(res, 200, {
      revenueShare: config.revenueShare,
      ads: ads.map((a) => ({
        id: a.id,
        brand: a.brand,
        line: a.ad_line,
        url: a.url,
        cat: a.category,
      })),
    });
  });

  route("GET", "/v1/leaderboard", async (req, res) => {
    const rows = await repo.leaderboard();
    json(res, 200, {
      leaderboard: rows.map((r, i) => ({ rank: i + 1, brand: r.brand, line: r.ad_line })),
    });
  });

  // ---------- devices & events ----------
  route("POST", "/v1/devices/register", async (req, res) => {
    json(res, 200, await repo.registerDevice());
  });

  route("POST", "/v1/events", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.batchKey || !Array.isArray(body.events)) {
      return json(res, 400, { error: "batchKey and events[] required" });
    }
    try {
      const result = await repo.ingestBatch({
        deviceId: device.id,
        batchKey: body.batchKey,
        events: body.events,
        revenueShare: config.revenueShare,
        dailyCap: config.dailyImpressionCap,
      });
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err.code === "CAP_EXCEEDED") return json(res, 429, { error: "daily impression cap exceeded" });
      throw err;
    }
  });

  // ---------- money in: advertiser checkout ----------
  route("POST", "/v1/checkout", async (req, res, body) => {
    const { email, adLine, url, brand, category, pricePerBlock, blocks, showOnLeaderboard } = body || {};
    const priceCents = Math.round(Number(pricePerBlock) * 100);
    const nBlocks = parseInt(blocks, 10);
    if (!email || !adLine || adLine.length < 3 || adLine.length > 60)
      return json(res, 400, { error: "email and 3-60 char adLine required" });
    if (!/^https:\/\//.test(url || "")) return json(res, 400, { error: "https url required" });
    if (!(priceCents >= 100)) return json(res, 400, { error: "min bid is $1.00 per block" });
    if (!(nBlocks >= 1)) return json(res, 400, { error: "at least 1 block" });

    const campaignId = await repo.createPendingCampaign({
      email, brand, adLine, url, category,
      pricePerBlockCents: priceCents,
      blocks: nBlocks,
      showOnLeaderboard,
    });

    const session = await stripe.createCheckoutSession({
      mode: "payment",
      customer_email: email,
      line_items: [{
        quantity: nBlocks,
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          product_data: {
            name: "Betterbacks spinner block — 1,000 impressions",
            description: `"${adLine}"`,
          },
        },
      }],
      metadata: { campaign_id: campaignId },
      success_url: `${config.siteUrl}/?checkout=success`,
      cancel_url: `${config.siteUrl}/?checkout=cancelled`,
    });
    await repo.attachCheckoutSession(campaignId, session.id);
    json(res, 200, { campaignId, checkoutUrl: session.url });
  });

  // ---------- Stripe webhooks ----------
  route("POST", "/v1/webhooks/stripe", async (req, res, body, rawBody) => {
    const ok = verifyWebhookSignature(rawBody, req.headers["stripe-signature"], config.stripeWebhookSecret);
    if (!ok) return json(res, 400, { error: "bad signature" });

    const event = body;
    switch (event.type) {
      case "checkout.session.completed": {
        const campaignId = event.data?.object?.metadata?.campaign_id;
        if (campaignId) await repo.activateCampaign(campaignId);
        break;
      }
      case "account.updated": {
        const acct = event.data?.object;
        if (acct?.id) {
          await repo.setPayoutsEnabledByAccount(acct.id, !!(acct.charges_enabled && acct.payouts_enabled));
        }
        break;
      }
      default:
        break; // acknowledge everything else
    }
    json(res, 200, { received: true });
  });

  // ---------- money out: developer onboarding & earnings ----------
  route("POST", "/v1/connect/onboard", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.email) return json(res, 400, { error: "email required" });

    const user = await repo.linkDeviceToUser(device.id, body.email);
    let accountId = user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.createAccount({
        type: "express",
        email: body.email,
        capabilities: { transfers: { requested: true } },
        business_type: "individual",
      });
      accountId = account.id;
      await repo.setStripeAccount(user.id, accountId);
    }
    const link = await stripe.createAccountLink({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${config.siteUrl}/?onboarding=retry`,
      return_url: `${config.siteUrl}/?onboarding=done`,
    });
    json(res, 200, { onboardingUrl: link.url });
  });

  route("GET", "/v1/me/earnings", async (req, res, body, rawBody, query) => {
    const device = await authDeviceFrom(null, query);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    const e = await repo.earningsForDevice(device.id);
    json(res, 200, {
      revenueShare: config.revenueShare,
      earnedUsd: e.earnedMillicents / 100000,
      paidOutUsd: e.paidOutMillicents / 100000,
      balanceUsd: e.balanceMillicents / 100000,
      payoutThresholdUsd: config.payoutThresholdCents / 100,
    });
  });

  // ---------- payouts sweep ----------
  route("POST", "/v1/admin/payouts", async (req, res, body) => {
    if (!config.adminKey || body?.adminKey !== config.adminKey)
      return json(res, 401, { error: "bad admin key" });
    const result = await runPayouts({ repo, stripe, config });
    json(res, 200, result);
  });

  // ---------- server plumbing ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return json(res, 404, { error: "not found" });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); }
      catch { return json(res, 400, { error: "invalid json" }); }
    }

    try {
      await handler(req, res, body, rawBody, url.searchParams);
    } catch (err) {
      console.error(`[betterbacks] ${req.method} ${url.pathname} failed:`, err.message);
      json(res, 500, { error: "internal error" });
    }
  });

  return { server };
}

module.exports = { createApp };
