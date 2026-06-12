// Betterbacks API — plain node:http, no framework.
// Dependency-injected ({ repo, stripe, mailer, rateLimiter, config }) so the test
// harness runs the real routes against a real database with fake Stripe/mail.

const http = require("node:http");
const { verifyWebhookSignature } = require("./stripe");
const { runPayouts } = require("./payouts");
const { escapeHtml, isCleanAdLine } = require("./util");

function createApp({ repo, stripe, mailer, rateLimiter, config }) {
  // Killswitch: when off, /v1/config tells extensions to stop serving and
  // /v1/ads returns an empty list (covers older extensions that never check
  // config). Toggled at runtime by an admin; resets to the env default
  // (KILLSWITCH) on restart.
  let serving = !config.killswitch;

  const exact = new Map();
  const params = []; // { method, regex, keys, handler }

  function route(method, path, handler) {
    if (path.includes(":")) {
      const keys = [];
      const regex = new RegExp(
        "^" + path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$"
      );
      params.push({ method, regex, keys, handler });
    } else {
      exact.set(`${method} ${path}`, handler);
    }
  }

  const CORS = {
    "Access-Control-Allow-Origin": config.corsOrigin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key",
    "Access-Control-Max-Age": "86400",
  };
  const json = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { ...CORS, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  };
  const redirect = (res, url) => { res.writeHead(302, { ...CORS, Location: url }); res.end(); };
  const html = (res, status, body) => {
    res.writeHead(status, { ...CORS, "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  };

  async function authDeviceFrom(body, query) {
    const deviceId = body?.deviceId || query?.get("deviceId");
    const deviceKey = body?.deviceKey || query?.get("deviceKey");
    return repo.authDevice(deviceId, deviceKey);
  }
  function adminOk(req, body, query) {
    const key = req.headers["x-admin-key"] || body?.adminKey || query?.get("adminKey");
    return config.adminKey && key === config.adminKey;
  }

  // ---------- health & catalog ----------
  route("GET", "/healthz", async (req, res) => json(res, 200, { ok: true }));

  route("GET", "/v1/config", async (req, res) =>
    json(res, 200, { serving, revenueShare: config.revenueShare })
  );

  route("GET", "/v1/ads", async (req, res) => {
    const ads = serving ? await repo.activeAds() : [];
    json(res, 200, {
      revenueShare: config.revenueShare,
      ads: ads.map((a) => ({ id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category })),
    });
  });

  route("GET", "/v1/leaderboard", async (req, res) => {
    const rows = await repo.leaderboard();
    json(res, 200, { leaderboard: rows.map((r, i) => ({ rank: i + 1, brand: r.brand, line: r.ad_line })) });
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
        deviceId: device.id, batchKey: body.batchKey, events: body.events,
        revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
      });
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err.code === "CAP_EXCEEDED") return json(res, 429, { error: "daily impression cap exceeded" });
      throw err;
    }
  });

  // ---------- server-side clicks ----------
  // The extension asks for a single-use token (authenticated), then points the
  // ad link at /v1/go/:token. Clicks can't be forged by editing the URL.
  route("POST", "/v1/clicks/intent", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.campaignId) return json(res, 400, { error: "campaignId required" });
    const token = await repo.createClickToken(body.campaignId, device.id, config.clickTokenTtlMs);
    if (!token) return json(res, 404, { error: "campaign not active" });
    json(res, 200, { trackingUrl: `${config.apiBaseUrl}/v1/go/${token}` });
  });

  route("GET", "/v1/go/:token", async (req, res, body, rawBody, query, p) => {
    const result = await repo.redeemClickToken(p.token, config.revenueShare);
    redirect(res, result?.url || config.siteUrl);
  });

  // ---------- money in: advertiser checkout ----------
  route("POST", "/v1/checkout", async (req, res, body) => {
    const { email, adLine, url, brand, category, pricePerBlock, blocks, showOnLeaderboard } = body || {};
    const priceCents = Math.round(Number(pricePerBlock) * 100);
    const nBlocks = parseInt(blocks, 10);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });
    if (!isCleanAdLine(adLine)) return json(res, 400, { error: "ad line must be 3-60 printable chars, no < >" });
    if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(res, 400, { error: "https url required" });
    if (!(priceCents >= 100)) return json(res, 400, { error: "min bid is $1.00 per block" });
    if (!(nBlocks >= 1)) return json(res, 400, { error: "at least 1 block" });

    const campaignId = await repo.createPendingCampaign({
      email, brand, adLine, url, category, pricePerBlockCents: priceCents, blocks: nBlocks, showOnLeaderboard,
    });
    const session = await stripe.createCheckoutSession({
      mode: "payment", customer_email: email,
      line_items: [{
        quantity: nBlocks,
        price_data: {
          currency: "usd", unit_amount: priceCents,
          product_data: { name: "Betterbacks spinner block — 1,000 impressions", description: `"${adLine}"` },
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
    if (!verifyWebhookSignature(rawBody, req.headers["stripe-signature"], config.stripeWebhookSecret)) {
      return json(res, 400, { error: "bad signature" });
    }
    const event = body;
    // exactly-once: Stripe retries, so dedupe on event id
    const fresh = await repo.claimWebhookEvent(event.id, event.type);
    if (!fresh) return json(res, 200, { received: true, duplicate: true });

    switch (event.type) {
      case "checkout.session.completed": {
        const obj = event.data?.object || {};
        if (obj.metadata?.campaign_id) await repo.markCampaignPaid(obj.metadata.campaign_id, obj.payment_intent);
        break;
      }
      case "account.updated": {
        const acct = event.data?.object;
        if (acct?.id) await repo.setPayoutsEnabledByAccount(acct.id, !!(acct.charges_enabled && acct.payouts_enabled));
        break;
      }
      default: break;
    }
    json(res, 200, { received: true });
  });

  // ---------- email verification (before payouts) ----------
  route("POST", "/v1/auth/request-link", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return json(res, 400, { error: "valid email required" });
    const token = await repo.createEmailToken(body.email, device.id, config.emailTokenTtlMs);
    await mailer.sendVerifyEmail(body.email, `${config.apiBaseUrl}/v1/auth/verify?token=${token}`);
    json(res, 200, { ok: true, sent: true });
  });

  route("GET", "/v1/auth/verify", async (req, res, body, rawBody, query) => {
    const user = await repo.verifyEmailToken(query.get("token"));
    if (!user) return redirect(res, `${config.siteUrl}/?verified=0`);
    redirect(res, `${config.siteUrl}/?verified=1`);
  });

  // ---------- money out: developer onboarding & earnings ----------
  route("POST", "/v1/connect/onboard", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    const user = await repo.userForDevice(device.id);
    if (!user || !user.email_verified) return json(res, 403, { error: "verify your email first" });

    let accountId = user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.createAccount({
        type: "express", email: user.email,
        capabilities: { transfers: { requested: true } }, business_type: "individual",
      });
      accountId = account.id;
      await repo.setStripeAccount(user.id, accountId);
    }
    const link = await stripe.createAccountLink({
      account: accountId, type: "account_onboarding",
      refresh_url: `${config.siteUrl}/?onboarding=retry`, return_url: `${config.siteUrl}/?onboarding=done`,
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

  // ---------- moderation ----------
  route("GET", "/v1/admin/campaigns", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    json(res, 200, { campaigns: await repo.pendingReviewCampaigns() });
  });

  route("POST", "/v1/admin/campaigns/approve", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const ok = await repo.approveCampaign(body.campaignId);
    json(res, ok ? 200 : 404, { ok });
  });

  route("POST", "/v1/admin/campaigns/reject", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const result = await repo.rejectCampaign(body.campaignId, body.note);
    if (!result) return json(res, 404, { ok: false });
    if (result.paymentIntentId) {
      try { await stripe.createRefund({ payment_intent: result.paymentIntentId }); }
      catch (err) { console.error("[betterbacks] refund failed:", err.message); }
    }
    json(res, 200, { ok: true, refunded: !!result.paymentIntentId });
  });

  // Minimal moderation UI. Admin key passed in the query; ad lines are escaped.
  route("GET", "/admin", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return html(res, 401, "<h1>401</h1><p>Append ?adminKey=…</p>");
    const key = escapeHtml(query.get("adminKey") || "");
    const list = await repo.pendingReviewCampaigns();
    const rows = list.map((c) => `
      <tr>
        <td>${escapeHtml(c.brand || "—")}</td>
        <td class="line">${escapeHtml(c.ad_line)}</td>
        <td><a href="${escapeHtml(c.url)}" rel="noopener noreferrer nofollow" target="_blank">link</a></td>
        <td>$${(c.price_per_block_cents / 100).toFixed(2)} × ${c.blocks}</td>
        <td>
          <button onclick="act('approve','${escapeHtml(c.id)}')">Approve</button>
          <button class="rej" onclick="act('reject','${escapeHtml(c.id)}')">Reject</button>
        </td>
      </tr>`).join("");
    html(res, 200, `<!doctype html><meta charset=utf-8><title>Betterbacks moderation</title>
<style>body{font:14px system-ui;margin:40px;max-width:900px}table{width:100%;border-collapse:collapse}
td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}.line{font-family:monospace}
button{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
button.rej{border-color:#e33;color:#e33}h1{font-size:20px}</style>
<h1>Pending review (${list.length})</h1>
<table><tr><th>Brand</th><th>Ad line</th><th>URL</th><th>Bid</th><th></th></tr>${rows || '<tr><td colspan=5>Nothing to review 🎉</td></tr>'}</table>
<script>
const KEY=${JSON.stringify(query.get("adminKey") || "")};
async function act(kind,id){
  const note = kind==='reject' ? prompt('Reason (optional):') || '' : '';
  await fetch('/v1/admin/campaigns/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminKey:KEY,campaignId:id,note})});
  location.reload();
}
</script>`);
  });

  // ---------- killswitch ----------
  route("POST", "/v1/admin/killswitch", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    if (typeof body.serving !== "boolean") return json(res, 400, { error: "serving (boolean) required" });
    serving = body.serving;
    json(res, 200, { ok: true, serving });
  });

  // ---------- payouts sweep ----------
  route("POST", "/v1/admin/payouts", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    json(res, 200, await runPayouts({ repo, stripe, config }));
  });

  // ---------- server plumbing ----------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, "http://localhost");

    // CORS preflight
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

    // rate limit by client IP
    if (rateLimiter) {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
      if (!rateLimiter.take(ip)) return json(res, 429, { error: "rate limited" });
    }

    // resolve handler (exact, then param routes)
    let handler = exact.get(`${req.method} ${url.pathname}`);
    let routeParams = {};
    if (!handler) {
      for (const r of params) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.regex);
        if (m) { handler = r.handler; r.keys.forEach((k, i) => (routeParams[k] = decodeURIComponent(m[i + 1]))); break; }
      }
    }
    if (!handler) return json(res, 404, { error: "not found" });

    // read body with a size cap
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > config.maxBodyBytes) { json(res, 413, { error: "payload too large" }); req.destroy(); return; }
        chunks.push(chunk);
      }
    } catch { return; }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); }
      catch { return json(res, 400, { error: "invalid json" }); }
    }

    try {
      await handler(req, res, body, rawBody, url.searchParams, routeParams);
    } catch (err) {
      console.error(`[betterbacks] ${req.method} ${url.pathname} failed:`, err.message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    } finally {
      if (config.logRequests !== false) {
        console.log(`[betterbacks] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return { server };
}

module.exports = { createApp };
