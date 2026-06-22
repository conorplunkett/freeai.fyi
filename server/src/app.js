// FreeAI API — plain node:http, no framework.
// Dependency-injected ({ repo, stripe, mailer, rateLimiter, config }) so the test
// harness runs the real routes against a real database with fake Stripe/mail.

const http = require("node:http");
const crypto = require("node:crypto");
const { verifyWebhookSignature } = require("./stripe");
const { GIFT_PLANS, GIFT_MONTHS, giftPriceCents } = require("./giftcards");
const { runPayouts } = require("./payouts");
const { escapeHtml, isCleanAdLine, normalizeHexColor } = require("./util");

// Validate + normalize an affiliate application's socials. At least one of
// Instagram / LinkedIn / Twitter is required, and every handle provided must
// carry a non-negative follower count. Handles are trimmed, '@'-stripped, and
// length-bounded. Returns { socials } or { error }.
function parseAffiliateSocials(body) {
  const b = body || {};
  const handle = (v) => {
    const s = String(v ?? "").trim().replace(/^@+/, "").slice(0, 60);
    return s || null;
  };
  const platforms = [
    ["instagram", "instagramFollowers", "Instagram"],
    ["linkedin", "linkedinFollowers", "LinkedIn"],
    ["twitter", "twitterFollowers", "Twitter"],
  ];
  const socials = {};
  let any = false;
  for (const [hKey, fKey, label] of platforms) {
    const h = handle(b[hKey]);
    socials[hKey] = h;
    socials[fKey] = null;
    if (!h) continue;
    any = true;
    const raw = b[fKey];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? "").replace(/[,\s]/g, ""), 10);
    if (!Number.isFinite(n) || n < 0) return { error: `${label} follower count is required` };
    socials[fKey] = Math.floor(n);
  }
  if (!any) return { error: "add at least one social handle (Instagram, LinkedIn, or Twitter)" };
  return { socials };
}

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
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key,Authorization",
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
  // Client IP from the proxy header (Fly/CDN) or the socket. Used for rate
  // limiting and — hashed, never stored raw — for the per-IP fraud cap.
  function clientIp(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  }
  function hashIp(req) {
    const ip = clientIp(req);
    return ip ? crypto.createHmac("sha256", config.adminKey || "ip-salt").update(ip).digest("hex") : null;
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
      ads: ads.map((a) => ({ id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined })),
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
        // Which product reported this batch (chrome / claude_code / desktop), so a
        // credit can be attributed to its surface; ignored unless allow-listed.
        source: ["chrome", "claude_code", "desktop"].includes(body.source) ? body.source : null,
        revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
        ipHash: hashIp(req), ipDailyCap: config.ipDailyImpressionCap,
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
    const result = await repo.redeemClickToken(p.token, config.revenueShare, config.dailyClickCap);
    redirect(res, result?.url || config.siteUrl);
  });

  // ---------- money in: advertiser checkout ----------
  route("POST", "/v1/checkout", async (req, res, body) => {
    const { email, adLine, url, brand, category, color, pricePerBlock, blocks, showOnLeaderboard } = body || {};
    const priceCents = Math.round(Number(pricePerBlock) * 100);
    const nBlocks = parseInt(blocks, 10);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });
    if (!isCleanAdLine(adLine)) return json(res, 400, { error: "ad line must be 3-60 printable chars, no < >" });
    if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(res, 400, { error: "https url required" });
    if (!(priceCents >= 50)) return json(res, 400, { error: "min bid is $0.50 per block" });
    if (!(nBlocks >= 1)) return json(res, 400, { error: "at least 1 block" });

    const campaignId = await repo.createPendingCampaign({
      email, brand, adLine, url, category, color: normalizeHexColor(color),
      pricePerBlockCents: priceCents, blocks: nBlocks, showOnLeaderboard,
    });
    const session = await stripe.createCheckoutSession({
      mode: "payment", customer_email: email,
      // receipt_email isn't a Checkout Session param; it lives on the PaymentIntent.
      payment_intent_data: { receipt_email: email },
      line_items: [{
        quantity: nBlocks,
        price_data: {
          currency: "usd", unit_amount: priceCents,
          product_data: {
            name: "FreeAI spinner block — 1,000 impressions",
            description: `${brand ? brand + " — " : ""}"${adLine}" → ${url}`,
            images: ["https://freeai.fyi/og.png"],
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
        if (obj.metadata?.campaign_id) {
          const paid = await repo.markCampaignPaid(obj.metadata.campaign_id, obj.payment_intent);
          // Only on the transitioning call (paid is the campaign details, not
          // false). Wrapped so a mail outage never rolls back the funded state —
          // the webhook event is already claimed and won't be retried.
          if (paid) {
            try {
              await mailer.sendAdvertiserReceiptEmail(paid.email, {
                campaignId: obj.metadata.campaign_id,
                brand: paid.brand,
                adLine: paid.adLine,
                pricePerBlockCents: paid.pricePerBlockCents,
                blocks: paid.blocks,
              });
            } catch (err) {
              console.error("[freeai] advertiser receipt email failed", err);
            }
          }
        }
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
    const token = await repo.createEmailToken(body.email, device.id, config.emailTokenTtlMs, null, config.emailCooldownMs);
    if (token) await mailer.sendVerifyEmail(body.email, `${config.apiBaseUrl}/v1/auth/verify?token=${token}`);
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
      redeemedUsd: e.redeemedMillicents / 100000,
      balanceUsd: e.balanceMillicents / 100000,
      payoutThresholdUsd: config.payoutThresholdCents / 100,
    });
  });

  // ---------- gift card redemptions ----------
  route("GET", "/v1/giftcards", async (req, res) => {
    json(res, 200, {
      plans: Object.values(GIFT_PLANS).map((p) => ({
        id: p.id, name: p.name, tagline: p.tagline, monthlyUsd: p.monthlyCents / 100,
      })),
      months: GIFT_MONTHS,
      deliveryWindowHours: 48,
    });
  });

  // Redemption is a website-only, logged-in flow (see AGENTS.md): credits are
  // cashed out at /v1/web/redemptions behind a web session. The old
  // device-credential path is retired — a leaked deviceKey must let someone
  // accrue credits in your name, never cash them out. Old clients get a clear,
  // safe refusal instead of a money-out they can't be trusted with.
  route("POST", "/v1/redemptions", async (req, res) => {
    json(res, 410, {
      error: "redeem on the website after signing in",
      redeemUrl: `${config.siteUrl}/redeem.html`,
    });
  });

  // ---------- OAuth helpers ----------
  // The signed state carries a CSRF nonce plus (optionally) the referral code the
  // user typed on the signup form, so it survives the round-trip through the OAuth
  // provider tamper-proof. Returns null when invalid/expired, else { ref }.
  function makeOAuthState(ref) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const ts = Date.now();
    const code = String(ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    const payload = `${ts}.${nonce}.${code}`;
    const sig = crypto.createHmac("sha256", config.adminKey || "fallback").update(payload).digest("hex").slice(0, 20);
    return `${payload}.${sig}`;
  }
  function verifyOAuthState(state) {
    if (!state) return null;
    const lastDot = state.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = state.slice(0, lastDot);
    const sig = state.slice(lastDot + 1);
    const expected = crypto.createHmac("sha256", config.adminKey || "fallback").update(payload).digest("hex").slice(0, 20);
    if (sig !== expected) return null;
    const parts = payload.split(".");
    const ts = parseInt(parts[0], 10);
    if (!Number.isFinite(ts) || Date.now() - ts >= 10 * 60 * 1000) return null;
    return { ref: parts[2] || "" };
  }
  // Convert DER-encoded ECDSA signature to IEEE P1363 (JWT ES256 format).
  function derEcdsaToP1363(der) {
    let i = 2; // skip SEQUENCE (0x30) tag + 1-byte length
    i++;       // skip INTEGER (0x02) tag for r
    const rLen = der[i++];
    const r = der.slice(i, i + rLen);
    i += rLen;
    i++;       // skip INTEGER (0x02) tag for s
    const sLen = der[i++];
    const s = der.slice(i, i + sLen);
    const fit32 = (b) => { const out = Buffer.alloc(32); b.slice(b.length > 32 ? b.length - 32 : 0).copy(out, 32 - Math.min(b.length, 32)); return out; };
    return Buffer.concat([fit32(r), fit32(s)]);
  }
  function decodeJwtPayload(token) {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
    catch { return null; }
  }
  // Build the short-lived JWT Apple requires as its client_secret (ES256).
  function buildAppleClientSecret() {
    if (!config.applePrivateKey || !config.appleTeamId || !config.appleKeyId || !config.appleClientId) return null;
    const hdr = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.appleKeyId })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const pay = Buffer.from(JSON.stringify({
      iss: config.appleTeamId, iat: now, exp: now + 300,
      aud: "https://appleid.apple.com", sub: config.appleClientId,
    })).toString("base64url");
    const input = `${hdr}.${pay}`;
    const sign = crypto.createSign("SHA256");
    sign.update(input);
    const der = sign.sign(config.applePrivateKey);
    return `${input}.${derEcdsaToP1363(der).toString("base64url")}`;
  }

  // ---------- Google OAuth ----------
  route("GET", "/v1/auth/google", async (req, res, body, rawBody, query) => {
    if (!config.googleClientId) return redirect(res, `${config.siteUrl}/redeem.html?login=no-google`);
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`,
      response_type: "code",
      scope: "email profile",
      state: makeOAuthState(query.get("ref")),
      access_type: "online",
      prompt: "select_account",
    });
    redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  route("GET", "/v1/auth/google/callback", async (req, res, body, rawBody, query) => {
    if (query.get("error") || !query.get("code")) {
      return redirect(res, `${config.siteUrl}/redeem.html?login=cancelled`);
    }
    const oauthState = verifyOAuthState(query.get("state"));
    if (!oauthState) {
      return redirect(res, `${config.siteUrl}/redeem.html?login=error`);
    }
    try {
      const tokRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.get("code"),
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`,
          grant_type: "authorization_code",
        }).toString(),
      });
      const tokens = await tokRes.json();
      if (!tokens.access_token) throw new Error("no access_token");
      const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const gu = await uiRes.json();
      if (!gu.email) throw new Error("no email from Google");
      const { sessionToken } = await repo.upsertUserByOAuth(
        { email: gu.email, googleId: gu.sub, referralCode: oauthState.ref,
          emailVerified: gu.email_verified === true || gu.email_verified === "true" },
        config.webSessionTtlMs
      );
      redirect(res, `${config.siteUrl}/redeem.html#session=${sessionToken}`);
    } catch (err) {
      console.error("[freeai] google oauth:", err.message);
      redirect(res, `${config.siteUrl}/redeem.html?login=error`);
    }
  });

  // ---------- Apple OAuth ----------
  route("GET", "/v1/auth/apple", async (req, res, body, rawBody, query) => {
    if (!config.appleClientId) return redirect(res, `${config.siteUrl}/redeem.html?login=no-apple`);
    const params = new URLSearchParams({
      client_id: config.appleClientId,
      redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`,
      response_type: "code",
      scope: "email",
      response_mode: "query",
      state: makeOAuthState(query.get("ref")),
    });
    redirect(res, `https://appleid.apple.com/auth/authorize?${params}`);
  });

  route("GET", "/v1/auth/apple/callback", async (req, res, body, rawBody, query) => {
    if (query.get("error") || !query.get("code")) {
      return redirect(res, `${config.siteUrl}/redeem.html?login=cancelled`);
    }
    const oauthState = verifyOAuthState(query.get("state"));
    if (!oauthState) {
      return redirect(res, `${config.siteUrl}/redeem.html?login=error`);
    }
    try {
      const secret = buildAppleClientSecret();
      if (!secret) throw new Error("Apple credentials not configured");
      const tokRes = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.get("code"),
          client_id: config.appleClientId,
          client_secret: secret,
          redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`,
          grant_type: "authorization_code",
        }).toString(),
      });
      const tokens = await tokRes.json();
      if (!tokens.id_token) throw new Error("no id_token from Apple");
      const claims = decodeJwtPayload(tokens.id_token);
      if (!claims?.sub) throw new Error("no sub in Apple id_token");
      const { sessionToken } = await repo.upsertUserByOAuth(
        { email: claims.email || null, appleId: claims.sub, referralCode: oauthState.ref,
          emailVerified: claims.email_verified === true || claims.email_verified === "true" },
        config.webSessionTtlMs
      );
      redirect(res, `${config.siteUrl}/redeem.html#session=${sessionToken}`);
    } catch (err) {
      console.error("[freeai] apple oauth:", err.message);
      redirect(res, `${config.siteUrl}/redeem.html?login=error`);
    }
  });

  // ---------- website login + redemption (the only place users redeem) ----------
  // Email magic link → web session → read balance → redeem for a Claude gift card.
  function sessionFrom(req, body, query) {
    const h = req.headers["authorization"] || "";
    const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
    return bearer || body?.session || query?.get("session") || null;
  }

  route("POST", "/v1/web/login", async (req, res, body) => {
    if (!body?.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
      return json(res, 400, { error: "valid email required" });
    }
    const token = await repo.createEmailToken(body.email, null, config.emailTokenTtlMs, body.referralCode, config.emailCooldownMs);
    if (token) await mailer.sendWebLoginEmail(body.email, `${config.apiBaseUrl}/v1/web/session?token=${token}`);
    json(res, 200, { ok: true, sent: true });
  });

  route("GET", "/v1/web/session", async (req, res, body, rawBody, query) => {
    const result = await repo.createWebSessionFromToken(query.get("token"), config.webSessionTtlMs);
    if (!result) return redirect(res, `${config.siteUrl}/redeem.html?login=expired`);
    redirect(res, `${config.siteUrl}/redeem.html#session=${result.sessionToken}`);
  });

  route("GET", "/v1/web/me", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const bal = await repo.balanceForUser(user.id);
    const [hasSurvey, referred] = await Promise.all([
      repo.hasOnboardingSurvey(user.id),
      repo.hasReferredAnyone(user.id),
    ]);
    json(res, 200, {
      email: user.email, balanceUsd: bal.balanceMillicents / 100000,
      needsSurvey: !hasSurvey, needsReferral: !referred,
    });
  });

  // Sign out: revoke the session server-side so the bearer token is dead even
  // if it lingers in a browser/localStorage or was copied elsewhere. Always 200
  // (idempotent) — clearing the client-side token is the caller's job.
  route("POST", "/v1/web/logout", async (req, res, body, rawBody, query) => {
    await repo.deleteWebSession(sessionFrom(req, body, query));
    json(res, 200, { ok: true });
  });

  // Earnings dashboard: lifetime / today / month-to-date credit totals plus a
  // time-bucketed series for the activity chart. ?window=24h|7d|30d selects the
  // chart window (24h is hourly buckets; 7d/30d are daily). Cards are
  // window-independent; the front end re-fetches only to change the chart.
  route("GET", "/v1/web/earnings", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });

    const window = ({ "24h": "24h", "7d": "7d", "30d": "30d" })[query.get("window")] || "7d";
    const bucket = window === "24h" ? "hour" : "day";
    const sinceMs = window === "24h" ? 24 * 3600e3 : (window === "7d" ? 7 : 30) * 86400e3;
    const since = new Date(Date.now() - sinceMs);

    const e = await repo.earningsForUser(user.id);
    const series = await repo.earningsSeriesForUser(user.id, { bucket, since });
    json(res, 200, {
      todayUsd: e.todayMillicents / 100000,
      monthUsd: e.monthMillicents / 100000,
      lifetimeUsd: e.lifetimeMillicents / 100000,
      balanceUsd: e.balanceMillicents / 100000,
      redeemedUsd: e.redeemedMillicents / 100000,
      window,
      series: series.map((b) => ({ t: b.t, usd: b.millicents / 100000, count: b.count })),
    });
  });

  // Activity ledger: the user's most recent credited events (impressions,
  // clicks, referral bonuses), newest first. Searching and filtering happen
  // client-side over the returned rows.
  route("GET", "/v1/web/activity", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });

    const rows = await repo.recentCreditsForUser(user.id, query.get("limit") || 200);
    json(res, 200, {
      count: rows.length,
      rows: rows.map((r) => ({
        id: String(r.id),
        createdAt: r.createdAt,
        type: r.entryType,
        amountUsd: r.amountMillicents / 100000,
        advertiser: r.advertiser,
        meta: r.meta,
      })),
    });
  });

  // Per-service activation for the Install tab: true once the account has
  // received its first credit from that surface (chrome / claude_code / desktop).
  route("GET", "/v1/web/sources", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const sources = await repo.sourcesForUser(user.id);
    json(res, 200, { sources });
  });

  // The user's referral dashboard: their shareable link/code, the reward terms,
  // and progress toward the cap. Refer a friend; when they redeem their first
  // gift card, you earn the bonus.
  route("GET", "/v1/web/referrals", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const code = await repo.getOrCreateReferralCode(user.id);
    const stats = await repo.referralStats(user.id);
    json(res, 200, {
      code,
      link: `${config.siteUrl}/redeem.html?ref=${code}`,
      rewardUsd: config.referralRewardCents / 100,
      cap: config.referralCap,
      rewardedCount: stats.rewardedCount,
      pendingCount: stats.pendingCount,
      invitedCount: stats.invitedCount,
      creditsEarnedUsd: stats.creditsEarnedMillicents / 100000,
      referrals: stats.referrals,
    });
  });

  // The user's ad-surface waitlists. GET returns the catalog of surfaces (from
  // the enum table) annotated with which ones the user has already joined; POST
  // joins one. Joining is idempotent — a repeat is a no-op.
  route("GET", "/v1/web/waitlist", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const surfaces = await repo.listWaitlistSurfaces();
    const joined = new Set((await repo.waitlistsForUser(user.id)).map((w) => w.surface));
    json(res, 200, {
      surfaces: surfaces.map((s) => ({ surface: s.surface, label: s.label, joined: joined.has(s.surface) })),
    });
  });

  route("POST", "/v1/web/waitlist", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const surface = body?.surface;
    const known = await repo.listWaitlistSurfaces();
    if (!surface || !known.some((s) => s.surface === surface)) {
      return json(res, 400, { error: "unknown surface", surfaces: known.map((s) => s.surface) });
    }
    const created = await repo.joinWaitlist(user.id, surface);
    json(res, 200, { ok: true, surface, joined: true, alreadyJoined: !created });
  });

  // Invite a friend by email. Records the invite (the "sent" indicator) and
  // emails them the user's referral link. You can't refer your own address —
  // the code only ever attributes a brand-new account, so self-referral is both
  // pointless and rejected here for a clear error.
  route("POST", "/v1/web/referrals/invite", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const email = String(body?.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { error: "valid email required" });
    }
    if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
      return json(res, 400, { error: "you can't refer your own email" });
    }
    const code = await repo.getOrCreateReferralCode(user.id);
    const link = `${config.siteUrl}/redeem.html?ref=${code}`;
    const invite = await repo.createReferralInvite(user.id, email, code);
    await mailer.sendReferralInviteEmail(email, {
      inviterEmail: user.email,
      link,
      rewardUsd: config.referralRewardCents / 100,
    });
    json(res, 200, {
      ok: true,
      sent: true,
      invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at },
    });
  });

  // ---------- affiliate program ----------
  // The caller's affiliate state: their application + program terms (if any),
  // and whether they can still attach an affiliate code to their account.
  route("GET", "/v1/web/affiliate", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const data = await repo.affiliateForUser(user.id);
    const app = data.application;
    json(res, 200, {
      application: app ? {
        status: app.status,
        code: app.code,
        link: app.code ? `${config.siteUrl}/redeem.html?ref=${app.code}` : null,
        socials: app.socials,
        rewardPct: app.rewardBps / 100,
        capUsd: app.capMillicents / 100000,
        creditedUsd: app.creditedMillicents / 100000,
        attributedCount: app.attributedCount,
        createdAt: app.createdAt,
      } : null,
      attributed: data.attributed,
      hasReferrer: data.hasReferrer,
      canApplyCode: !data.attributed && !data.hasReferrer,
    });
  });

  // Apply to join the affiliate program (social handles + follower counts).
  route("POST", "/v1/web/affiliate/apply", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const parsed = parseAffiliateSocials(body);
    if (parsed.error) return json(res, 400, { error: parsed.error });
    const created = await repo.submitAffiliateApplication(user.id, parsed.socials);
    if (!created) return json(res, 409, { error: "you've already applied" });
    json(res, 200, { ok: true, status: created.status });
  });

  // Retroactively attach an affiliate code to your own account. Allowed only
  // when you have no existing attribution; referral codes can't be applied here.
  route("POST", "/v1/web/affiliate-code", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const code = String(body?.code || "").trim();
    if (!code) return json(res, 400, { error: "code required" });
    const result = await repo.applyAffiliateCodeForUser(user.id, code);
    if (result.ok) return json(res, 200, { ok: true });
    const msg = {
      already_affiliated: "your account already has an affiliate code",
      has_referrer: "your account was referred, so an affiliate code can't be added",
      invalid_code: "that affiliate code isn't valid",
    }[result.reason] || "couldn't apply that code";
    json(res, 400, { error: msg, reason: result.reason });
  });

  // First-login onboarding survey: which AI models the user uses and where, both
  // multi-select. Saved before the refer-a-friend step; clears the needsSurvey gate.
  route("POST", "/v1/web/onboarding/survey", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const MODELS = ["claude", "chatgpt", "gemini", "other"];
    const SURFACES = ["browser_chrome", "browser_other", "desktop_app", "cursor", "terminal", "other"];
    const models = [...new Set((Array.isArray(body?.models) ? body.models : []).filter((m) => MODELS.includes(m)))];
    const surfaces = [...new Set((Array.isArray(body?.surfaces) ? body.surfaces : []).filter((s) => SURFACES.includes(s)))];
    if (!models.length || !surfaces.length) {
      return json(res, 400, { error: "select at least one model and one surface" });
    }
    const surfaceOther = surfaces.includes("other")
      ? (String(body?.surfaceOther || "").trim().slice(0, 200) || null)
      : null;
    await repo.saveOnboardingSurvey(user.id, { models, surfaces, surfaceOther });
    json(res, 200, { ok: true });
  });

  route("POST", "/v1/web/redemptions", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });

    const plan = GIFT_PLANS[body.plan];
    const months = parseInt(body.months, 10);
    const amountCents = plan ? giftPriceCents(plan.id, months) : null;
    if (!amountCents) return json(res, 400, { error: "plan must be pro/max5x/max20x and months 1/3/6/12" });

    // Gift cards are delivered only to the account's own email — never an
    // address supplied in the request. This caps the blast radius of a stolen
    // session: a hijacked token can't redirect a cash-out to an attacker inbox.
    const recipientEmail = user.email;
    if (!recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
      return json(res, 400, { error: "your account needs a verified email to redeem" });
    }

    const balance = await repo.balanceForUser(user.id);
    if (balance.balanceMillicents < amountCents * 1000) {
      return json(res, 403, {
        error: "insufficient credits",
        balanceUsd: balance.balanceMillicents / 100000,
        requiredUsd: amountCents / 100,
      });
    }

    // Email the fulfillment inbox first, then deduct; the in-transaction balance
    // re-check inside recordGiftRedemptionForUser keeps concurrent redeems honest.
    const redemptionId = crypto.randomUUID();
    await mailer.sendGiftRedemptionEmail(config.giftFulfillmentEmail, {
      redemptionId, planName: plan.name, months, amountUsd: amountCents / 100, recipientEmail,
    });
    const recorded = await repo.recordGiftRedemptionForUser({
      id: redemptionId, userId: user.id, plan: plan.id, months, amountCents, recipientEmail,
      referralRewardMillicents: config.referralRewardCents * 1000,
      referralCap: config.referralCap,
    });
    if (!recorded) return json(res, 409, { error: "insufficient credits" });

    const after = await repo.balanceForUser(user.id);
    json(res, 200, {
      ok: true, redemptionId, plan: plan.id, months,
      amountUsd: amountCents / 100,
      balanceUsd: after.balanceMillicents / 100000,
      deliveryWindowHours: 48,
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
      catch (err) { console.error("[freeai] refund failed:", err.message); }
    }
    // Tell the advertiser their campaign was rejected + refunded. Wrapped so a
    // mail failure never fails the moderation action (already committed above).
    try {
      await mailer.sendCampaignRejectedEmail(result.email, {
        campaignId: body.campaignId,
        brand: result.brand,
        adLine: result.adLine,
        pricePerBlockCents: result.pricePerBlockCents,
        blocks: result.blocks,
        note: result.note,
      });
    } catch (err) {
      console.error("[freeai] rejection email failed:", err.message);
    }
    json(res, 200, { ok: true, refunded: !!result.paymentIntentId });
  });

  // ---------- affiliate review ----------
  route("GET", "/v1/admin/affiliates", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    json(res, 200, { affiliates: await repo.listAffiliateApplications() });
  });

  route("POST", "/v1/admin/affiliates/approve", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const result = await repo.approveAffiliate(body.affiliateId);
    json(res, result ? 200 : 404, result ? { ok: true, code: result.code } : { ok: false });
  });

  route("POST", "/v1/admin/affiliates/reject", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const result = await repo.rejectAffiliate(body.affiliateId, body.note);
    json(res, result ? 200 : 404, { ok: !!result });
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
    html(res, 200, `<!doctype html><meta charset=utf-8><title>FreeAI moderation</title>
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
      const ip = clientIp(req) || "?";
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
      console.error(`[freeai] ${req.method} ${url.pathname} failed:`, err.message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    } finally {
      if (config.logRequests !== false) {
        console.log(`[freeai] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return { server };
}

module.exports = { createApp };
