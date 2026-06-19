// @ts-nocheck
// FreeAI API — full port of the node:http server (server/src/*) to a single
// Supabase Edge Function (Deno). Replaces the Fly.io deployment.
//
// Faithful port: every route, the exact SQL, the millicent BigInt math, the
// transaction-scoped advisory locks, Stripe webhook verification, and the
// Google/Apple OAuth flows are preserved. The data layer uses postgres.js
// behind a node-postgres-shaped shim so server/src/repo.js transfers almost
// verbatim (same Pool/client API).
//
// Routing: this function is deployed under the slug `api`, so the public base
// is https://<ref>.supabase.co/functions/v1/api and requests arrive as
// /api/v1/...  — we strip the slug prefix and route on the original paths.
// Deployed with verify_jwt=false: the API does its own auth (web-session
// tokens, device keys, admin key, OAuth, Stripe signatures), not Supabase JWTs.
//
// Differences from the Node server (see supabase/functions/README.md):
//  - the in-memory per-IP token-bucket rate limiter is dropped (Edge Functions
//    are stateless); the DB-backed per-device/-IP fraud caps in ingestBatch and
//    redeemClickToken are unchanged and remain the real abuse controls.
//  - the runtime killswitch toggle is per-isolate only; `serving` is derived
//    from the KILLSWITCH env on each cold start.
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import postgres from "npm:postgres@3.4.4";

// ───────────────────────────── config ──────────────────────────────────────
const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
function loadConfig() {
  const siteUrl = env("SITE_URL", "https://freeai.fyi");
  return {
    databaseUrl: env("SUPABASE_DB_URL") || env("DATABASE_URL"),
    stripeSecretKey: env("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET"),
    // Connect (connected-account) events arrive on a separate event destination
    // with its own signing secret, so we verify webhooks against either.
    stripeConnectWebhookSecret: env("STRIPE_CONNECT_WEBHOOK_SECRET"),
    siteUrl,
    // Where Stripe/OAuth/magic-link callbacks point. Defaults to this function.
    apiBaseUrl: env("API_BASE_URL") || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/api` : ""),
    corsOrigin: env("CORS_ORIGIN") || siteUrl,
    adminKey: env("ADMIN_KEY"),
    killswitch: env("KILLSWITCH") === "1",
    revenueShare: parseFloat(env("REVENUE_SHARE", "0.5")),
    grossCpmCents: parseInt(env("GROSS_CPM_CENTS", "1200"), 10),
    dailyImpressionCap: parseInt(env("DAILY_IMPRESSION_CAP", "5000"), 10),
    ipDailyImpressionCap: parseInt(env("IP_DAILY_IMPRESSION_CAP", "5000"), 10), // per source IP per UTC day; 0 disables
    dailyClickCap: parseInt(env("DAILY_CLICK_CAP", "100"), 10),
    payoutThresholdCents: parseInt(env("PAYOUT_THRESHOLD_CENTS", "1000"), 10),
    referralRewardCents: parseInt(env("REFERRAL_REWARD_CENTS", "2000"), 10),
    referralCap: parseInt(env("REFERRAL_CAP", "10"), 10),
    giftFulfillmentEmail: env("GIFT_FULFILLMENT_EMAIL", "conor.p43@gmail.com"),
    emailTokenTtlMs: parseInt(env("EMAIL_TOKEN_TTL_MS", "1800000"), 10),
    webSessionTtlMs: parseInt(env("WEB_SESSION_TTL_MS", "2592000000"), 10),
    clickTokenTtlMs: parseInt(env("CLICK_TOKEN_TTL_MS", "120000"), 10),
    maxBodyBytes: parseInt(env("MAX_BODY_BYTES", "65536"), 10),
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
    appleClientId: env("APPLE_CLIENT_ID"),
    appleTeamId: env("APPLE_TEAM_ID"),
    appleKeyId: env("APPLE_KEY_ID"),
    applePrivateKey: env("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
    mailProvider: env("MAIL_PROVIDER", "console"),
    resendApiKey: env("RESEND_API_KEY"),
    mailFrom: env("MAIL_FROM"),
  };
}
const config = loadConfig();

// ─────────────────────────── postgres pool ─────────────────────────────────
// SUPABASE_DB_URL points at the Supavisor pooler inside the platform network.
// node-postgres (`pg`) cannot load in the Deno edge runtime (it crashes the
// worker at boot), so we use postgres.js — the same driver web-referrals uses.
// prepare:false is required under transaction-mode pooling.
//
// A thin pg-compatible shim (.query → {rows}, .begin(fn) for transactions)
// keeps createRepo — written against node-postgres' Pool/Client API — unchanged,
// including its transaction-scoped advisory locks. Transactions use sql.begin,
// which pins one connection for BEGIN…COMMIT (and pg_advisory_xact_lock).
const sql = postgres(config.databaseUrl, { prepare: false });
// Wrap a postgres.js handle (the pool, or a transaction handle) in the
// node-postgres-shaped client createRepo expects: `.query(text, params)` -> {rows}.
const clientFor = (h: any) => ({
  query: async (text: string, params: any[] = []) => {
    const rows = await h.unsafe(text, params);
    return { rows, rowCount: rows.length };
  },
});
const pool = {
  query: (text: string, params: any[] = []) => clientFor(sql).query(text, params),
  // Transactions use postgres.js's first-class sql.begin: one pinned connection
  // with automatic COMMIT / ROLLBACK-on-throw. This is the reliable path under
  // transaction-mode pooling and keeps our pg_advisory_xact_lock guards correct.
  begin: (fn: any) => sql.begin((tx: any) => fn(clientFor(tx))),
};

// ───────────────────────────── util.js ─────────────────────────────────────
function escapeHtml(s: any) {
  return String(s == null ? "" : s).replace(/[&<>"'/]/g, (ch: string) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#47;",
  } as any)[ch]);
}
function isCleanAdLine(s: any) {
  if (typeof s !== "string") return false;
  if (s.length < 3 || s.length > 60) return false;
  if (s.includes("<") || s.includes(">")) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
// Guard user-supplied campaign ids before they hit a uuid column: a non-uuid
// value makes Postgres throw (22P02), which would abort a whole batch tx.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: any) {
  return typeof s === "string" && UUID_RE.test(s);
}

// Advertiser accent color, "#rrggbb" or bare "rrggbb" → canonical "#rrggbb",
// else null (client falls back to a per-brand color).
function normalizeHexColor(value: any) {
  if (value == null || value === "") return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

// ─────────────────────────── giftcards.js ──────────────────────────────────
const GIFT_PLANS: any = {
  pro: { id: "pro", name: "Claude Pro", tagline: "For the curious", monthlyCents: 2000 },
  max5x: { id: "max5x", name: "Claude Max 5x", tagline: "For the enthusiast", monthlyCents: 10000 },
  max20x: { id: "max20x", name: "Claude Max 20x", tagline: "For the power user", monthlyCents: 20000 },
};
const GIFT_MONTHS = [1, 3, 6, 12];
function giftPriceCents(planId: string, months: number) {
  const plan = GIFT_PLANS[planId];
  if (!plan || !GIFT_MONTHS.includes(months)) return null;
  return plan.monthlyCents * months;
}

// ───────────────────────────── stripe.js ───────────────────────────────────
const STRIPE_API = "https://api.stripe.com/v1";
function formEncode(obj: any, prefix = "", out: string[] = []): string {
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item: any, i: number) => {
        if (typeof item === "object") formEncode(item, `${name}[${i}]`, out);
        else out.push(`${name}[${i}]=${encodeURIComponent(item)}`);
      });
    } else if (typeof val === "object") {
      formEncode(val, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(val as any)}`);
    }
  }
  return out.join("&");
}
class StripeError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) {
    super(`Stripe ${status}: ${body?.error?.message || JSON.stringify(body)}`);
    this.status = status; this.body = body;
  }
}
function createStripe(secretKey: string) {
  async function request(method: string, path: string, params?: any) {
    const res = await fetch(STRIPE_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2024-06-20",
      },
      body: params ? formEncode(params) : undefined,
    });
    const body = await res.json();
    if (!res.ok) throw new StripeError(res.status, body);
    return body;
  }
  return {
    createCheckoutSession: (p: any) => request("POST", "/checkout/sessions", p),
    createRefund: (p: any) => request("POST", "/refunds", p),
    createAccount: (p: any) => request("POST", "/accounts", p),
    createAccountLink: (p: any) => request("POST", "/account_links", p),
    createTransfer: (p: any) => request("POST", "/transfers", p),
    request,
  };
}
function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string, toleranceSec = 300) {
  if (!signatureHeader) return false;
  const parts: any = Object.create(null);
  const v1s: string[] = [];
  for (const piece of signatureHeader.split(",")) {
    const [k, v] = piece.split("=", 2);
    if (k === "v1") v1s.push(v);
    else parts[k.trim()] = v;
  }
  const t = parseInt(parts.t, 10);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1s.some((sig) => {
    try { return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); }
    catch { return false; }
  });
}
const stripe = createStripe(config.stripeSecretKey);

// ───────────────────────────── mailer.js ───────────────────────────────────
function createMailer(cfg: any) {
  const provider = cfg.mailProvider || "console";
  async function send(to: string, subject: string, htmlBody: string) {
    if (provider === "resend" && cfg.resendApiKey) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.mailFrom || "FreeAI <hello@freeai.fyi>", to, subject, html: htmlBody }),
      });
      if (!res.ok) throw new Error("resend send failed: " + res.status + " " + (await res.text().catch(() => "")).slice(0, 300));
      return;
    }
    console.log(`[freeai][mail] to=${to} subject="${subject}"`);
  }
  return {
    sendVerifyEmail: (to: string, link: string) => send(to, "Verify your email to get paid",
      `<p>Confirm this address to start receiving FreeAI payouts.</p>
       <p><a href="${link}">Verify my email</a></p>
       <p>This link expires in 30 minutes. If you didn't request it, ignore this email.</p>`),
    sendWebLoginEmail: (to: string, link: string) => send(to, "Your FreeAI sign-in link",
      `<p>Click to sign in and redeem your FreeAI credits for Claude.</p>
       <p><a href="${link}">Sign in to FreeAI</a></p>
       <p>This link expires in 30 minutes. If you didn't request it, ignore this email.</p>`),
    sendAdvertiserReceiptEmail: (to: string, { campaignId, brand, adLine, pricePerBlockCents, blocks }: any) =>
      send(to, "Your FreeAI campaign receipt",
      `<p>Thanks for advertising on FreeAI — your payment is confirmed.</p>
       <ul>
         <li><strong>Ad line:</strong> "${adLine}"</li>
         ${brand ? `<li><strong>Brand:</strong> ${brand}</li>` : ""}
         <li><strong>Blocks:</strong> ${blocks} (${(blocks * 1000).toLocaleString("en-US")} impressions)</li>
         <li><strong>Price per block:</strong> US$${(pricePerBlockCents / 100).toFixed(2)}</li>
         <li><strong>Total paid:</strong> US$${((pricePerBlockCents * blocks) / 100).toFixed(2)}</li>
         <li><strong>Campaign id:</strong> ${campaignId}</li>
       </ul>
       <p>Your campaign is now in review and goes live once we approve it — usually within a day.</p>
       <p>Stripe has emailed a separate itemized payment receipt for your records.</p>`),
    sendCampaignRejectedEmail: (to: string, { campaignId, brand, adLine, pricePerBlockCents, blocks, note }: any) =>
      send(to, "Your FreeAI campaign was refunded",
      `<p>Thanks for your interest in advertising on FreeAI. We weren't able to approve this campaign, so we've refunded it in full.</p>
       <ul>
         <li><strong>Ad line:</strong> "${adLine}"</li>
         ${brand ? `<li><strong>Brand:</strong> ${brand}</li>` : ""}
         <li><strong>Refunded:</strong> US$${((pricePerBlockCents * blocks) / 100).toFixed(2)}</li>
         <li><strong>Campaign id:</strong> ${campaignId}</li>
       </ul>
       ${note ? `<p><strong>Reviewer note:</strong> ${note}</p>` : ""}
       <p>The refund returns to your original payment method; Stripe will email a separate confirmation. You're welcome to submit a new campaign any time.</p>`),
    sendGiftRedemptionEmail: (to: string, { redemptionId, planName, months, amountUsd, recipientEmail }: any) =>
      send(to, `Gift card redemption: ${months} month${months > 1 ? "s" : ""} of ${planName}`,
      `<p>A FreeAI user redeemed their credits for a Claude gift card.</p>
       <ul>
         <li><strong>Plan:</strong> ${planName}</li>
         <li><strong>Duration:</strong> ${months} month${months > 1 ? "s" : ""}</li>
         <li><strong>Value:</strong> US$${amountUsd.toFixed(2)}</li>
         <li><strong>Send the gift card to:</strong> ${recipientEmail}</li>
         <li><strong>Redemption id:</strong> ${redemptionId}</li>
       </ul>
       <p>Please fulfill within 48 hours.</p>`),
    sendReferralInviteEmail: (to: string, { inviterEmail, link, rewardUsd }: any) =>
      send(to, `${inviterEmail} invited you to FreeAI — free Claude credits`,
      `<p>${inviterEmail} is using FreeAI to earn free Claude credits and wants you in.</p>
       <p>FreeAI shows one subtle sponsored line while you use ChatGPT, Claude, or
          Gemini, and pays you back 50% of the revenue as Claude credits.</p>
       <p><a href="${link}">Accept the invite and claim your credits</a></p>
       <p>When you sign up with this link and redeem your first Claude gift card,
          ${inviterEmail} earns a one-time $${Math.round(rewardUsd)} bonus — at no cost to you.</p>`),
  };
}
const mailer = createMailer(config);

// ────────────────────────────── repo.js ────────────────────────────────────
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateReferralCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return out;
}
// Mask a referred friend's email for the dashboard (jane@acme.com -> j•••@acme.com)
// so the page never leaks the full address of someone who signed up via a link.
function maskEmail(email: string) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at < 1) return "•••";
  const local = s.slice(0, at);
  const head = local.length > 1 ? local[0] : "";
  return `${head}•••@${s.slice(at + 1)}`;
}
const LOCK_REDEEM = 0x52454431; // "RED1"

function createRepo(pool: any) {
  async function tx(fn: any) {
    return pool.begin(fn);
  }

  async function applyReferral(client: any, newUserId: string, refCode: any) {
    if (!refCode) return;
    const code = String(refCode).trim().toUpperCase();
    if (!code) return;
    const r = await client.query("select id from users where upper(referral_code) = $1", [code]);
    const referrer = r.rows[0];
    if (!referrer || referrer.id === newUserId) return;
    await client.query("update users set referred_by = $2 where id = $1 and referred_by is null", [newUserId, referrer.id]);
    await client.query(
      `insert into referrals (referrer_user_id, referred_user_id, status)
       values ($1, $2, 'pending') on conflict (referred_user_id) do nothing`,
      [referrer.id, newUserId]
    );
    const ne = await client.query("select email from users where id = $1", [newUserId]);
    if (ne.rows[0]?.email) {
      await client.query(
        `update referral_invites set status = 'joined', joined_at = now()
          where referrer_user_id = $1 and lower(email) = lower($2) and status = 'sent'`,
        [referrer.id, ne.rows[0].email]
      );
    }
  }

  async function maybeRewardReferral(client: any, referredUserId: string, rewardMillicents: any, cap: number) {
    const ref = await client.query(
      `select id, referrer_user_id from referrals where referred_user_id = $1 and status = 'pending' for update`,
      [referredUserId]
    );
    if (!ref.rows[0]) return;
    const { id, referrer_user_id } = ref.rows[0];
    const cnt = await client.query(
      "select count(*)::int as n from referrals where referrer_user_id = $1 and status = 'rewarded'",
      [referrer_user_id]
    );
    if (cnt.rows[0].n >= cap) {
      await client.query("update referrals set status = 'capped' where id = $1", [id]);
      return;
    }
    await client.query(
      `insert into ledger (entry_type, amount_millicents, user_id, meta)
       values ('referral_credit', $1, $2, $3)`,
      [String(rewardMillicents), referrer_user_id, JSON.stringify({ referralId: id, referredUserId })]
    );
    await client.query(
      `update referrals set status = 'rewarded', rewarded_at = now(), reward_millicents = $2 where id = $1`,
      [id, String(rewardMillicents)]
    );
    const re = await client.query("select email from users where id = $1", [referredUserId]);
    if (re.rows[0]?.email) {
      await client.query(
        `update referral_invites set status = 'rewarded', rewarded_at = now()
          where referrer_user_id = $1 and lower(email) = lower($2) and status <> 'rewarded'`,
        [referrer_user_id, re.rows[0].email]
      );
    }
  }

  return {
    async registerDevice() {
      const secret = crypto.randomBytes(32).toString("hex");
      const { rows } = await pool.query("insert into devices (key_hash) values ($1) returning id", [sha256(secret)]);
      return { deviceId: rows[0].id, deviceKey: secret };
    },
    async authDevice(deviceId: string, deviceKey: string) {
      if (!deviceId || !deviceKey) return null;
      const { rows } = await pool.query(
        "update devices set last_seen_at = now() where id = $1 and key_hash = $2 returning id, user_id",
        [deviceId, sha256(deviceKey)]
      );
      return rows[0] || null;
    },
    async activeAds(limit = 20) {
      const { rows } = await pool.query(
        `select id, brand, ad_line, url, category, color, price_per_block_cents, show_on_leaderboard
           from campaigns where status = 'active' and impressions_remaining > 0
          order by price_per_block_cents desc, activated_at asc limit $1`,
        [limit]
      );
      return rows;
    },
    async leaderboard(limit = 15) {
      const { rows } = await pool.query(
        `select brand, ad_line, price_per_block_cents from campaigns
          where status in ('active', 'exhausted') and show_on_leaderboard
          order by price_per_block_cents desc, activated_at asc limit $1`,
        [limit]
      );
      return rows;
    },
    async createPendingCampaign({ email, brand, adLine, url, category, color, pricePerBlockCents, blocks, showOnLeaderboard }: any) {
      return tx(async (c: any) => {
        const adv = await c.query("insert into advertisers (email) values ($1) returning id", [email]);
        const { rows } = await c.query(
          `insert into campaigns
             (advertiser_id, brand, ad_line, url, category, color, price_per_block_cents,
              blocks, impressions_total, impressions_remaining, show_on_leaderboard)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) returning id`,
          [adv.rows[0].id, brand || null, adLine, url, category || "other", color || null,
           pricePerBlockCents, blocks, blocks * 1000, showOnLeaderboard !== false]
        );
        return rows[0].id;
      });
    },
    async attachCheckoutSession(campaignId: string, sessionId: string) {
      await pool.query("update campaigns set stripe_checkout_session_id = $2 where id = $1", [campaignId, sessionId]);
    },
    async markCampaignPaid(campaignId: string, paymentIntentId: string) {
      return tx(async (c: any) => {
        const { rows } = await c.query(
          `update campaigns cmp set status = 'pending_review', paid_at = now(),
                  stripe_payment_intent_id = coalesce($2, cmp.stripe_payment_intent_id)
             from advertisers adv
            where cmp.id = $1 and cmp.status = 'pending_payment'
              and adv.id = cmp.advertiser_id
            returning adv.email, cmp.brand, cmp.ad_line, cmp.price_per_block_cents, cmp.blocks`,
          [campaignId, paymentIntentId || null]
        );
        if (!rows[0]) return false;
        const funded = BigInt(rows[0].price_per_block_cents) * BigInt(rows[0].blocks) * 1000n;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('campaign_credit', $1, $2, $3)`,
          [funded.toString(), campaignId, JSON.stringify({ blocks: rows[0].blocks })]
        );
        return {
          email: rows[0].email,
          brand: rows[0].brand,
          adLine: rows[0].ad_line,
          pricePerBlockCents: rows[0].price_per_block_cents,
          blocks: rows[0].blocks,
        };
      });
    },
    async pendingReviewCampaigns(limit = 50) {
      const { rows } = await pool.query(
        `select id, brand, ad_line, url, category, price_per_block_cents, blocks, paid_at
           from campaigns where status = 'pending_review' order by paid_at asc limit $1`,
        [limit]
      );
      return rows;
    },
    async approveCampaign(campaignId: string) {
      const { rows } = await pool.query(
        `update campaigns set status = 'active', activated_at = now()
          where id = $1 and status = 'pending_review' returning id`,
        [campaignId]
      );
      return !!rows[0];
    },
    async rejectCampaign(campaignId: string, note: string) {
      return tx(async (c: any) => {
        const { rows } = await c.query(
          `update campaigns cmp set status = 'rejected', review_note = $2
             from advertisers adv
            where cmp.id = $1 and cmp.status = 'pending_review'
              and adv.id = cmp.advertiser_id
            returning adv.email, cmp.brand, cmp.ad_line,
                      cmp.price_per_block_cents, cmp.blocks, cmp.stripe_payment_intent_id`,
          [campaignId, note || null]
        );
        if (!rows[0]) return null;
        const refund = BigInt(rows[0].price_per_block_cents) * BigInt(rows[0].blocks) * 1000n;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('campaign_refund', $1, $2, $3)`,
          [(-refund).toString(), campaignId, JSON.stringify({ note: note || null })]
        );
        return {
          paymentIntentId: rows[0].stripe_payment_intent_id,
          email: rows[0].email,
          brand: rows[0].brand,
          adLine: rows[0].ad_line,
          pricePerBlockCents: rows[0].price_per_block_cents,
          blocks: rows[0].blocks,
          note: note || null,
        };
      });
    },
    async claimWebhookEvent(eventId: string, type: string) {
      if (!eventId) return true;
      const { rows } = await pool.query(
        `insert into processed_webhook_events (event_id, type) values ($1, $2)
         on conflict (event_id) do nothing returning event_id`,
        [eventId, type || null]
      );
      return !!rows[0];
    },
    async ingestBatch({ deviceId, batchKey, events, revenueShare, dailyCap, ipHash, ipDailyCap }: any) {
      return tx(async (c: any) => {
        const claimedImpressions = events.reduce((n: number, e: any) => n + (e.impressions || 0), 0);
        const claimedClicks = events.reduce((n: number, e: any) => n + (e.clicks || 0), 0);
        const ins = await c.query(
          `insert into event_batches (device_id, batch_key, impressions, clicks, ip_hash)
           values ($1,$2,$3,$4,$5) on conflict (batch_key) do nothing returning id`,
          [deviceId, batchKey, claimedImpressions, claimedClicks, ipHash || null]
        );
        if (!ins.rows[0]) return { duplicate: true, creditedMillicents: 0 };
        const cap = await c.query(
          `select coalesce(sum(impressions), 0)::bigint as n from event_batches
            where device_id = $1 and created_at >= date_trunc('day', now())`,
          [deviceId]
        );
        if (Number(cap.rows[0].n) > dailyCap) {
          const err: any = new Error("daily impression cap exceeded");
          err.code = "CAP_EXCEEDED";
          throw err;
        }
        // fraud cap: impressions per source IP per UTC day (hashed, fail-open,
        // disabled when ipDailyCap <= 0).
        if (ipHash && Number.isFinite(ipDailyCap) && ipDailyCap > 0) {
          const ipCap = await c.query(
            `select coalesce(sum(impressions), 0)::bigint as n from event_batches
              where ip_hash = $1 and created_at >= date_trunc('day', now())`,
            [ipHash]
          );
          if (Number(ipCap.rows[0].n) > ipDailyCap) {
            const err: any = new Error("daily ip impression cap exceeded");
            err.code = "CAP_EXCEEDED";
            throw err;
          }
        }
        let credited = 0n;
        for (const ev of events) {
          const imp = Math.max(0, ev.impressions | 0);
          const billable = imp;
          if (!billable) continue;
          // Skip demo/preview or otherwise non-uuid campaign ids — querying a
          // uuid column with them throws and would poison the transaction.
          if (!isUuid(ev.campaignId)) continue;
          const camp = await c.query(
            `select price_per_block_cents, impressions_remaining from campaigns
              where id = $1 and status = 'active' for update`,
            [ev.campaignId]
          );
          if (!camp.rows[0]) continue;
          const billed = Math.min(billable, camp.rows[0].impressions_remaining);
          if (!billed) continue;
          await c.query(
            `update campaigns set
               impressions_remaining = impressions_remaining - $2,
               status = case when impressions_remaining - $2 <= 0 then 'exhausted' else status end
             where id = $1`,
            [ev.campaignId, billed]
          );
          const gross = BigInt(camp.rows[0].price_per_block_cents) * BigInt(billed);
          const dev = (gross * BigInt(Math.round(revenueShare * 1000))) / 1000n;
          const fee = gross - dev;
          credited += dev;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
             values ('impression_credit', $1, $2, $3, $4)`,
            [dev.toString(), deviceId, ev.campaignId, JSON.stringify({ impressions: imp, billed })]
          );
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('platform_fee', $1, $2, '{}')`,
            [fee.toString(), ev.campaignId]
          );
        }
        return { duplicate: false, creditedMillicents: Number(credited) };
      });
    },
    async earningsForDevice(deviceId: string) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed
         from ledger
         where device_id = $1
            or user_id = (select user_id from devices where id = $1 and user_id is not null)`,
        [deviceId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out);
      const redeemed = Number(rows[0].redeemed);
      return { earnedMillicents: earned, paidOutMillicents: -paidOut, redeemedMillicents: -redeemed, balanceMillicents: earned + paidOut + redeemed };
    },
    async userForDevice(deviceId: string) {
      const { rows } = await pool.query(`select u.* from users u join devices d on d.user_id = u.id where d.id = $1`, [deviceId]);
      return rows[0] || null;
    },
    async createEmailToken(email: string, deviceId: string | null, ttlMs: number, referralCode?: any) {
      const token = crypto.randomBytes(32).toString("base64url");
      await pool.query(
        `insert into email_tokens (token, email, device_id, referral_code, expires_at)
         values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
        [token, email, deviceId || null, referralCode || null, String(ttlMs)]
      );
      return token;
    },
    async verifyEmailToken(token: string) {
      return tx(async (c: any) => {
        const t = await c.query(
          `update email_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now() returning email, device_id`,
          [token]
        );
        if (!t.rows[0]) return null;
        const { email, device_id } = t.rows[0];
        const u = await c.query(
          `insert into users (email, email_verified) values ($1, true)
           on conflict (email) do update set email_verified = true
           returning id, email, stripe_account_id, payouts_enabled, email_verified`,
          [email]
        );
        if (device_id) await c.query("update devices set user_id = $2 where id = $1", [device_id, u.rows[0].id]);
        return u.rows[0];
      });
    },
    async createClickToken(campaignId: string, deviceId: string, ttlMs: number) {
      if (!isUuid(campaignId)) return null;
      const camp = await pool.query("select 1 from campaigns where id = $1 and status = 'active'", [campaignId]);
      if (!camp.rows[0]) return null;
      const token = crypto.randomBytes(24).toString("base64url");
      await pool.query(
        `insert into click_tokens (token, campaign_id, device_id, expires_at)
         values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
        [token, campaignId, deviceId, String(ttlMs)]
      );
      return token;
    },
    async redeemClickToken(token: string, revenueShare: number, dailyClickCap: number) {
      return tx(async (c: any) => {
        const t = await c.query(
          `update click_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now() returning campaign_id, device_id`,
          [token]
        );
        if (!t.rows[0]) return null;
        const { campaign_id, device_id } = t.rows[0];
        let overCap = false;
        if (Number.isFinite(dailyClickCap)) {
          const used = await c.query(
            `select count(*)::int as n from ledger
              where device_id = $1 and entry_type = 'click_credit'
                and created_at >= date_trunc('day', now())`,
            [device_id]
          );
          if (used.rows[0].n >= dailyClickCap) overCap = true;
        }
        const camp = await c.query(
          `select url, price_per_block_cents, impressions_remaining from campaigns
            where id = $1 and status = 'active' for update`,
          [campaign_id]
        );
        if (!camp.rows[0]) return null;
        const billed = overCap ? 0 : Math.min(50, camp.rows[0].impressions_remaining);
        if (billed > 0) {
          await c.query(
            `update campaigns set
               impressions_remaining = impressions_remaining - $2,
               status = case when impressions_remaining - $2 <= 0 then 'exhausted' else status end
             where id = $1`,
            [campaign_id, billed]
          );
          const gross = BigInt(camp.rows[0].price_per_block_cents) * BigInt(billed);
          const dev = (gross * BigInt(Math.round(revenueShare * 1000))) / 1000n;
          const fee = gross - dev;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
             values ('click_credit', $1, $2, $3, $4)`,
            [dev.toString(), device_id, campaign_id, JSON.stringify({ via: "go", billed })]
          );
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('platform_fee', $1, $2, '{}')`,
            [fee.toString(), campaign_id]
          );
        }
        return { url: camp.rows[0].url };
      });
    },
    async setStripeAccount(userId: string, accountId: string) {
      await pool.query("update users set stripe_account_id = $2 where id = $1", [userId, accountId]);
    },
    async setPayoutsEnabledByAccount(accountId: string, enabled: boolean) {
      await pool.query("update users set payouts_enabled = $2 where stripe_account_id = $1", [accountId, enabled]);
    },
    async payableUsers(thresholdMillicents: number) {
      const { rows } = await pool.query(
        `select u.id, u.stripe_account_id,
                coalesce(sum(l.amount_millicents), 0)::bigint as balance
           from users u
           join devices d on d.user_id = u.id
           join ledger l on (l.device_id = d.id and l.entry_type in ('impression_credit','click_credit'))
          where u.payouts_enabled and u.stripe_account_id is not null
          group by u.id
         having coalesce(sum(l.amount_millicents), 0)
              + coalesce((select sum(amount_millicents) from ledger where user_id = u.id and entry_type = 'payout_debit'), 0)
              + coalesce((select sum(amount_millicents) from ledger
                           where entry_type = 'gift_redemption_debit'
                             and device_id in (select id from devices where user_id = u.id)), 0)
             >= $1`,
        [thresholdMillicents]
      );
      return rows.map((r: any) => ({ ...r, balance: Number(r.balance) }));
    },
    async upsertUserByOAuth({ email, googleId, appleId, referralCode, emailVerified }: any, sessionTtlMs: number) {
      return tx(async (c: any) => {
        const matchEmail = emailVerified ? (email || null) : null;
        let found: any = null;
        if (googleId) {
          const r = await c.query("select id, email, google_id, apple_id from users where google_id = $1", [googleId]);
          found = r.rows[0] || null;
        }
        if (!found && appleId) {
          const r = await c.query("select id, email, google_id, apple_id from users where apple_id = $1", [appleId]);
          found = r.rows[0] || null;
        }
        if (!found && matchEmail) {
          const r = await c.query("select id, email, google_id, apple_id from users where email = $1", [matchEmail]);
          found = r.rows[0] || null;
        }
        let userId;
        if (found) {
          const sets = ["email_verified = true"];
          const vals: any[] = [found.id];
          if (matchEmail && !found.email) { sets.push(`email = $${vals.length + 1}`); vals.push(matchEmail); }
          if (googleId && !found.google_id) { sets.push(`google_id = $${vals.length + 1}`); vals.push(googleId); }
          if (appleId && !found.apple_id) { sets.push(`apple_id = $${vals.length + 1}`); vals.push(appleId); }
          await c.query(`update users set ${sets.join(", ")} where id = $1`, vals);
          userId = found.id;
        } else {
          const r = await c.query(
            `insert into users (email, email_verified, google_id, apple_id)
             values ($1, true, $2, $3) returning id`,
            [matchEmail || null, googleId || null, appleId || null]
          );
          userId = r.rows[0].id;
          await applyReferral(c, userId, referralCode);
        }
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        await c.query(
          `insert into web_sessions (token, user_id, expires_at)
           values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
          [sessionToken, userId, String(sessionTtlMs)]
        );
        return { sessionToken };
      });
    },
    async createWebSessionFromToken(token: string, sessionTtlMs: number) {
      return tx(async (c: any) => {
        const t = await c.query(
          `update email_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now() returning email, referral_code`,
          [token]
        );
        if (!t.rows[0]) return null;
        const u = await c.query(
          `insert into users (email, email_verified) values ($1, true)
           on conflict (email) do update set email_verified = true
           returning id, email, (xmax = 0) as is_new`,
          [t.rows[0].email]
        );
        if (u.rows[0].is_new) await applyReferral(c, u.rows[0].id, t.rows[0].referral_code);
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        await c.query(
          `insert into web_sessions (token, user_id, expires_at)
           values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
          [sessionToken, u.rows[0].id, String(sessionTtlMs)]
        );
        return { sessionToken, user: { id: u.rows[0].id, email: u.rows[0].email } };
      });
    },
    async userForSession(sessionToken: string | null) {
      if (!sessionToken) return null;
      const { rows } = await pool.query(
        `select u.id, u.email from web_sessions s join users u on u.id = s.user_id
          where s.token = $1 and s.expires_at > now()`,
        [sessionToken]
      );
      return rows[0] || null;
    },
    async balanceForUser(userId: string) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed
         from ledger where user_id = $1 or device_id in (select id from devices where user_id = $1)`,
        [userId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out);
      const redeemed = Number(rows[0].redeemed);
      return { earnedMillicents: earned, paidOutMillicents: -paidOut, redeemedMillicents: -redeemed, balanceMillicents: earned + paidOut + redeemed };
    },
    async earningsForUser(userId: string) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit') and created_at >= date_trunc('day', now())), 0)::bigint as today,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit') and created_at >= date_trunc('month', now())), 0)::bigint as month,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed
         from ledger where user_id = $1 or device_id in (select id from devices where user_id = $1)`,
        [userId]
      );
      const earned = Number(rows[0].earned);
      const today = Number(rows[0].today);
      const month = Number(rows[0].month);
      const paidOut = Number(rows[0].paid_out);
      const redeemed = Number(rows[0].redeemed);
      return {
        lifetimeMillicents: earned, todayMillicents: today, monthMillicents: month,
        redeemedMillicents: -redeemed, paidOutMillicents: -paidOut,
        balanceMillicents: earned + paidOut + redeemed,
      };
    },
    async earningsSeriesForUser(userId: string, { bucket, since }: any) {
      const unit = bucket === "hour" ? "hour" : "day";
      const { rows } = await pool.query(
        `select date_trunc($2, created_at) as t,
                coalesce(sum(amount_millicents), 0)::bigint as millicents,
                count(*)::int as count
         from ledger
         where (user_id = $1 or device_id in (select id from devices where user_id = $1))
           and entry_type in ('impression_credit','click_credit','referral_credit')
           and created_at >= $3
         group by 1 order by 1 asc`,
        [userId, unit, since]
      );
      return rows.map((r: any) => ({ t: r.t, millicents: Number(r.millicents), count: r.count }));
    },
    async recentCreditsForUser(userId: string, limit: any) {
      const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 200));
      const { rows } = await pool.query(
        `select l.id, l.created_at, l.entry_type, l.amount_millicents, l.meta, c.brand
           from ledger l
           left join campaigns c on c.id = l.campaign_id
          where (l.user_id = $1 or l.device_id in (select id from devices where user_id = $1))
            and l.entry_type in ('impression_credit','click_credit','referral_credit')
          order by l.created_at desc limit $2`,
        [userId, n]
      );
      return rows.map((r: any) => ({
        id: r.id, createdAt: r.created_at, entryType: r.entry_type,
        amountMillicents: Number(r.amount_millicents), advertiser: r.brand || null, meta: r.meta || {},
      }));
    },
    async recordGiftRedemptionForUser({ id, userId, plan, months, amountCents, recipientEmail, referralRewardMillicents, referralCap }: any) {
      return tx(async (c: any) => {
        await c.query("select pg_advisory_xact_lock($1, hashtext($2))", [LOCK_REDEEM, `user:${userId}`]);
        const bal = await c.query(
          `select coalesce(sum(amount_millicents), 0)::bigint as balance from ledger
            where (user_id = $1 or device_id in (select id from devices where user_id = $1))
              and entry_type in ('impression_credit','click_credit','referral_credit','payout_debit','gift_redemption_debit')`,
          [userId]
        );
        const costMillicents = BigInt(amountCents) * 1000n;
        if (BigInt(bal.rows[0].balance) < costMillicents) return null;
        const { rows } = await c.query(
          `insert into gift_redemptions (id, user_id, plan, months, amount_cents, recipient_email)
           values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6) returning id`,
          [id || null, userId, plan, months, amountCents, recipientEmail]
        );
        await c.query(
          `insert into ledger (entry_type, amount_millicents, user_id, meta)
           values ('gift_redemption_debit', $1, $2, $3)`,
          [(-costMillicents).toString(), userId, JSON.stringify({ redemptionId: rows[0].id, plan, months })]
        );
        if (referralRewardMillicents) await maybeRewardReferral(c, userId, referralRewardMillicents, referralCap ?? 10);
        return rows[0].id;
      });
    },
    async getOrCreateReferralCode(userId: string) {
      const existing = await pool.query("select referral_code from users where id = $1", [userId]);
      if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;
      for (let i = 0; i < 6; i++) {
        const code = generateReferralCode();
        try {
          const r = await pool.query(
            "update users set referral_code = $2 where id = $1 and referral_code is null returning referral_code",
            [userId, code]
          );
          if (r.rows[0]) return r.rows[0].referral_code;
          const re = await pool.query("select referral_code from users where id = $1", [userId]);
          if (re.rows[0]?.referral_code) return re.rows[0].referral_code;
        } catch (err: any) {
          if (err.code === "23505") continue;
          throw err;
        }
      }
      throw new Error("could not allocate referral code");
    },
    async createReferralInvite(referrerUserId: string, email: string, code: string) {
      const r = await pool.query(
        `insert into referral_invites (referrer_user_id, email, code)
           values ($1, lower($2), $3)
         on conflict (referrer_user_id, email)
           do update set sent_at = now(), code = excluded.code
         returning email, status, sent_at`,
        [referrerUserId, email, code]
      );
      return r.rows[0];
    },
    async referralStats(userId: string) {
      const stats = await pool.query(
        `select
           count(*) filter (where status = 'rewarded')::int as rewarded,
           count(*) filter (where status = 'pending')::int as pending,
           count(*) filter (where status = 'capped')::int as capped,
           coalesce(sum(reward_millicents), 0)::bigint as earned_millicents
         from referrals where referrer_user_id = $1`,
        [userId]
      );
      const joined = await pool.query(
        `select u.email, r.status, r.created_at
           from referrals r join users u on u.id = r.referred_user_id
          where r.referrer_user_id = $1 order by r.created_at desc limit 100`,
        [userId]
      );
      const invited = await pool.query(
        `select email, sent_at as created_at from referral_invites
          where referrer_user_id = $1 and status = 'sent' order by sent_at desc limit 100`,
        [userId]
      );
      const s = stats.rows[0];
      const referrals = [
        ...invited.rows.map((r: any) => ({ email: maskEmail(r.email), status: "invited", createdAt: r.created_at })),
        ...joined.rows.map((r: any) => ({ email: maskEmail(r.email), status: r.status, createdAt: r.created_at })),
      ].sort((a: any, b: any) => +new Date(b.createdAt) - +new Date(a.createdAt));
      return {
        rewardedCount: s.rewarded, pendingCount: s.pending, cappedCount: s.capped,
        invitedCount: invited.rows.length,
        creditsEarnedMillicents: Number(s.earned_millicents),
        referrals,
      };
    },
    async recordPayout(userId: string, amountCents: number, transferId: string) {
      return tx(async (c: any) => {
        await c.query(
          `insert into ledger (entry_type, amount_millicents, user_id, meta)
           values ('payout_debit', $1, $2, $3)`,
          [(-BigInt(amountCents) * 1000n).toString(), userId, JSON.stringify({ transferId })]
        );
        await c.query("insert into payouts (user_id, amount_cents, stripe_transfer_id) values ($1,$2,$3)", [userId, amountCents, transferId]);
      });
    },
  };
}
const repo = createRepo(pool);

// ───────────────────────────── payouts.js ──────────────────────────────────
async function runPayouts() {
  const users = await repo.payableUsers(config.payoutThresholdCents * 1000);
  const results: any[] = [];
  for (const user of users) {
    const amountCents = Math.floor(user.balance / 1000);
    if (amountCents < config.payoutThresholdCents) continue;
    try {
      const transfer = await stripe.createTransfer({
        amount: amountCents, currency: "usd", destination: user.stripe_account_id,
        transfer_group: `payout_${user.id}_${crypto.randomUUID()}`,
      });
      await repo.recordPayout(user.id, amountCents, transfer.id);
      results.push({ userId: user.id, amountCents, transferId: transfer.id, ok: true });
    } catch (err: any) {
      results.push({ userId: user.id, amountCents, ok: false, error: err.message });
    }
  }
  return { paid: results.filter((r) => r.ok).length, results };
}

// ─────────────────────────── http plumbing ─────────────────────────────────
let serving = !config.killswitch;
// TEMP: capture the most recent unhandled route error for /v1/_diag.
let lastError: any = null;
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key,Authorization,apikey",
  "Access-Control-Max-Age": "86400",
};
// Allowed browser origins. Reflect the caller's Origin when it's on our
// allowlist (apex + www variants of SITE_URL, plus any CORS_ORIGIN entries) so
// both https://freeai.fyi and https://www.freeai.fyi pass preflight.
const ALLOWED_ORIGINS: Set<string> = (() => {
  const set = new Set<string>();
  const add = (o: string) => { const v = (o || "").trim().replace(/\/+$/, ""); if (v) set.add(v); };
  (env("CORS_ORIGIN") || config.siteUrl || "").split(",").forEach(add);
  try {
    const u = new URL(config.siteUrl);
    const host = u.host.replace(/^www\./, "");
    add(`${u.protocol}//${host}`);
    add(`${u.protocol}//www.${host}`);
  } catch { /* siteUrl not a URL — skip variants */ }
  return set;
})();
function resolveOrigin(req: Request): string {
  const o = (req.headers.get("Origin") || "").replace(/\/+$/, "");
  return ALLOWED_ORIGINS.has(o) ? o : (config.corsOrigin || "*");
}
const json = (status: number, body: any) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const redirect = (url: string) => new Response(null, { status: 302, headers: { ...CORS, Location: url } });
const htmlResp = (status: number, body: string) =>
  new Response(body, { status, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });

// route table (mirrors app.js)
const exact = new Map<string, any>();
const paramRoutes: any[] = [];
function route(method: string, path: string, handler: any) {
  if (path.includes(":")) {
    const keys: string[] = [];
    const regex = new RegExp("^" + path.replace(/:([A-Za-z0-9_]+)/g, (_: any, k: string) => { keys.push(k); return "([^/]+)"; }) + "$");
    paramRoutes.push({ method, regex, keys, handler });
  } else {
    exact.set(`${method} ${path}`, handler);
  }
}

// ctx: { headers, body, rawBody, query, params }
async function authDeviceFrom(ctx: any, fromQuery = false) {
  const src = fromQuery ? null : ctx.body;
  const deviceId = src?.deviceId || ctx.query.get("deviceId");
  const deviceKey = src?.deviceKey || ctx.query.get("deviceKey");
  return repo.authDevice(deviceId, deviceKey);
}
function adminOk(ctx: any) {
  const key = ctx.headers.get("x-admin-key") || ctx.body?.adminKey || ctx.query.get("adminKey");
  return config.adminKey && key === config.adminKey;
}
function sessionFrom(ctx: any) {
  const h = ctx.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
  return bearer || ctx.body?.session || ctx.query.get("session") || null;
}
// Client IP from the proxy header. Used — hashed, never stored raw — for the
// per-IP fraud cap.
function clientIp(ctx: any) {
  return (ctx.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "";
}
function hashIp(ctx: any) {
  const ip = clientIp(ctx);
  return ip ? crypto.createHmac("sha256", config.adminKey || "ip-salt").update(ip).digest("hex") : null;
}

// ── health & catalog ──
route("GET", "/healthz", async () => json(200, { ok: true }));
// TEMP diagnostic (admin-gated): surfaces whether plain queries and
// transactions work against the pooler, and the exact driver error if not.
route("GET", "/v1/_diag", async (ctx: any) => {
  if (!adminOk(ctx)) return json(403, { error: "forbidden" });
  const out: any = {};
  try { out.query = (await pool.query("select 1 as n")).rows[0]; }
  catch (e: any) { out.queryErr = String(e?.stack || e?.message || e); }
  try { out.tx = await pool.begin(async (c: any) => (await c.query("select 1 as n")).rows[0]); }
  catch (e: any) { out.txErr = String(e?.stack || e?.message || e); }
  try {
    const dev = await repo.registerDevice();
    const camp = (await pool.query("select id from campaigns where status = 'active' limit 1")).rows[0];
    out.campId = camp?.id || null;
    out.ingest = await repo.ingestBatch({
      deviceId: dev.deviceId, batchKey: "_diag-" + crypto.randomBytes(6).toString("hex"),
      events: camp ? [{ campaignId: camp.id, impressions: 1 }] : [],
      revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
      ipHash: null, ipDailyCap: 0,
    });
  } catch (e: any) { out.ingestErr = String(e?.stack || e?.message || e); }
  try {
    const dev = await repo.registerDevice();
    out.ingestDemo = await repo.ingestBatch({
      deviceId: dev.deviceId, batchKey: "_diagdemo-" + crypto.randomBytes(6).toString("hex"),
      events: [{ campaignId: "demo", impressions: 1 }],
      revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
      ipHash: null, ipDailyCap: 0,
    });
  } catch (e: any) { out.ingestDemoErr = String(e?.stack || e?.message || e); }
  out.lastError = lastError;
  return json(200, out);
});
route("GET", "/v1/config", async () => json(200, { serving, revenueShare: config.revenueShare }));
route("GET", "/v1/ads", async () => {
  const ads = serving ? await repo.activeAds() : [];
  return json(200, { revenueShare: config.revenueShare, ads: ads.map((a: any) => ({ id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined })) });
});
route("GET", "/v1/leaderboard", async () => {
  const rows = await repo.leaderboard();
  return json(200, { leaderboard: rows.map((r: any, i: number) => ({ rank: i + 1, brand: r.brand, line: r.ad_line })) });
});

// ── devices & events ──
route("POST", "/v1/devices/register", async () => json(200, await repo.registerDevice()));
route("POST", "/v1/events", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const body = ctx.body || {};
  if (!body.batchKey || !Array.isArray(body.events)) return json(400, { error: "batchKey and events[] required" });
  try {
    const result = await repo.ingestBatch({
      deviceId: device.id, batchKey: body.batchKey, events: body.events,
      revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
      ipHash: hashIp(ctx), ipDailyCap: config.ipDailyImpressionCap,
    });
    return json(200, { ok: true, ...result });
  } catch (err: any) {
    if (err.code === "CAP_EXCEEDED") return json(429, { error: "daily impression cap exceeded" });
    throw err;
  }
});

// ── server-side clicks ──
route("POST", "/v1/clicks/intent", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  if (!ctx.body?.campaignId) return json(400, { error: "campaignId required" });
  const token = await repo.createClickToken(ctx.body.campaignId, device.id, config.clickTokenTtlMs);
  if (!token) return json(404, { error: "campaign not active" });
  return json(200, { trackingUrl: `${config.apiBaseUrl}/v1/go/${token}` });
});
route("GET", "/v1/go/:token", async (ctx: any) => {
  const result = await repo.redeemClickToken(ctx.params.token, config.revenueShare, config.dailyClickCap);
  return redirect(result?.url || config.siteUrl);
});

// ── advertiser checkout ──
route("POST", "/v1/checkout", async (ctx: any) => {
  const { email, adLine, url, brand, category, color, pricePerBlock, blocks, showOnLeaderboard } = ctx.body || {};
  const priceCents = Math.round(Number(pricePerBlock) * 100);
  const nBlocks = parseInt(blocks, 10);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (!isCleanAdLine(adLine)) return json(400, { error: "ad line must be 3-60 printable chars, no < >" });
  if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(400, { error: "https url required" });
  if (!(priceCents >= 100)) return json(400, { error: "min bid is $1.00 per block" });
  if (!(nBlocks >= 1)) return json(400, { error: "at least 1 block" });
  const campaignId = await repo.createPendingCampaign({ email, brand, adLine, url, category, color: normalizeHexColor(color), pricePerBlockCents: priceCents, blocks: nBlocks, showOnLeaderboard });
  const session = await stripe.createCheckoutSession({
    mode: "payment", customer_email: email, receipt_email: email,
    line_items: [{ quantity: nBlocks, price_data: { currency: "usd", unit_amount: priceCents, product_data: { name: "FreeAI spinner block — 1,000 impressions", description: `"${adLine}"` } } }],
    metadata: { campaign_id: campaignId },
    success_url: `${config.siteUrl}/?checkout=success`,
    cancel_url: `${config.siteUrl}/?checkout=cancelled`,
  });
  await repo.attachCheckoutSession(campaignId, session.id);
  return json(200, { campaignId, checkoutUrl: session.url });
});

// ── Stripe webhooks ──
route("POST", "/v1/webhooks/stripe", async (ctx: any) => {
  const sig = ctx.headers.get("stripe-signature");
  const signed =
    verifyWebhookSignature(ctx.rawBody, sig, config.stripeWebhookSecret) ||
    (!!config.stripeConnectWebhookSecret &&
      verifyWebhookSignature(ctx.rawBody, sig, config.stripeConnectWebhookSecret));
  if (!signed) return json(400, { error: "bad signature" });
  const event = ctx.body;
  const fresh = await repo.claimWebhookEvent(event.id, event.type);
  if (!fresh) return json(200, { received: true, duplicate: true });
  switch (event.type) {
    case "checkout.session.completed": {
      const obj = event.data?.object || {};
      if (obj.metadata?.campaign_id) {
        const paid = await repo.markCampaignPaid(obj.metadata.campaign_id, obj.payment_intent);
        // Only on the transitioning call. Wrapped so a mail outage never rolls
        // back the funded state — the webhook event is already claimed.
        if (paid) {
          try {
            await mailer.sendAdvertiserReceiptEmail((paid as any).email, {
              campaignId: obj.metadata.campaign_id,
              brand: (paid as any).brand,
              adLine: (paid as any).adLine,
              pricePerBlockCents: (paid as any).pricePerBlockCents,
              blocks: (paid as any).blocks,
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
  return json(200, { received: true });
});

// ── email verification (before payouts) ──
route("POST", "/v1/auth/request-link", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  if (!ctx.body?.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ctx.body.email)) return json(400, { error: "valid email required" });
  const token = await repo.createEmailToken(ctx.body.email, device.id, config.emailTokenTtlMs);
  await mailer.sendVerifyEmail(ctx.body.email, `${config.apiBaseUrl}/v1/auth/verify?token=${token}`);
  return json(200, { ok: true, sent: true });
});
route("GET", "/v1/auth/verify", async (ctx: any) => {
  const user = await repo.verifyEmailToken(ctx.query.get("token"));
  return redirect(`${config.siteUrl}/?verified=${user ? 1 : 0}`);
});

// ── developer onboarding & earnings ──
route("POST", "/v1/connect/onboard", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const user = await repo.userForDevice(device.id);
  if (!user || !user.email_verified) return json(403, { error: "verify your email first" });
  let accountId = user.stripe_account_id;
  if (!accountId) {
    const account = await stripe.createAccount({ type: "express", email: user.email, capabilities: { transfers: { requested: true } }, business_type: "individual" });
    accountId = account.id;
    await repo.setStripeAccount(user.id, accountId);
  }
  const link = await stripe.createAccountLink({ account: accountId, type: "account_onboarding", refresh_url: `${config.siteUrl}/?onboarding=retry`, return_url: `${config.siteUrl}/?onboarding=done` });
  return json(200, { onboardingUrl: link.url });
});
route("GET", "/v1/me/earnings", async (ctx: any) => {
  const device = await authDeviceFrom(ctx, true);
  if (!device) return json(401, { error: "bad device credentials" });
  const e = await repo.earningsForDevice(device.id);
  return json(200, {
    revenueShare: config.revenueShare,
    earnedUsd: e.earnedMillicents / 100000, paidOutUsd: e.paidOutMillicents / 100000,
    redeemedUsd: e.redeemedMillicents / 100000, balanceUsd: e.balanceMillicents / 100000,
    payoutThresholdUsd: config.payoutThresholdCents / 100,
  });
});

// ── gift card catalog & device-scoped redemption ──
route("GET", "/v1/giftcards", async () => json(200, {
  plans: Object.values(GIFT_PLANS).map((p: any) => ({ id: p.id, name: p.name, tagline: p.tagline, monthlyUsd: p.monthlyCents / 100 })),
  months: GIFT_MONTHS, deliveryWindowHours: 48,
}));
// Redemption is a website-only, logged-in flow (see AGENTS.md): credits are
// cashed out at /v1/web/redemptions behind a web session. The old
// device-credential path is retired — a leaked deviceKey must let someone
// accrue credits in your name, never cash them out. Old clients get a clear,
// safe refusal instead of a money-out they can't be trusted with.
route("POST", "/v1/redemptions", async () => {
  return json(410, {
    error: "redeem on the website after signing in",
    redeemUrl: `${config.siteUrl}/redeem.html`,
  });
});

// ── OAuth helpers ──
function makeOAuthState(ref: any) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  const code = String(ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  const payload = `${ts}.${nonce}.${code}`;
  const sig = crypto.createHmac("sha256", config.adminKey || "fallback").update(payload).digest("hex").slice(0, 20);
  return `${payload}.${sig}`;
}
function verifyOAuthState(state: string | null) {
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
function derEcdsaToP1363(der: any) {
  let i = 2; i++;
  const rLen = der[i++];
  const r = der.slice(i, i + rLen);
  i += rLen; i++;
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  const fit32 = (b: any) => { const out = Buffer.alloc(32); b.slice(b.length > 32 ? b.length - 32 : 0).copy(out, 32 - Math.min(b.length, 32)); return out; };
  return Buffer.concat([fit32(r), fit32(s)]);
}
function decodeJwtPayload(token: string) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); } catch { return null; }
}
function buildAppleClientSecret() {
  if (!config.applePrivateKey || !config.appleTeamId || !config.appleKeyId || !config.appleClientId) return null;
  const hdr = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.appleKeyId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const pay = Buffer.from(JSON.stringify({ iss: config.appleTeamId, iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: config.appleClientId })).toString("base64url");
  const input = `${hdr}.${pay}`;
  const sign = crypto.createSign("SHA256");
  sign.update(input);
  const der = sign.sign(config.applePrivateKey);
  return `${input}.${derEcdsaToP1363(der).toString("base64url")}`;
}

// ── Google OAuth ──
route("GET", "/v1/auth/google", async (ctx: any) => {
  if (!config.googleClientId) return redirect(`${config.siteUrl}/redeem.html?login=no-google`);
  const params = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`,
    response_type: "code", scope: "email profile", state: makeOAuthState(ctx.query.get("ref")),
    access_type: "online", prompt: "select_account",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});
route("GET", "/v1/auth/google/callback", async (ctx: any) => {
  const query = ctx.query;
  if (query.get("error") || !query.get("code")) return redirect(`${config.siteUrl}/redeem.html?login=cancelled`);
  const oauthState = verifyOAuthState(query.get("state"));
  if (!oauthState) return redirect(`${config.siteUrl}/redeem.html?login=error`);
  try {
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: query.get("code"), client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`, grant_type: "authorization_code" }).toString(),
    });
    const tokens = await tokRes.json();
    if (!tokens.access_token) throw new Error("no access_token");
    const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const gu = await uiRes.json();
    if (!gu.email) throw new Error("no email from Google");
    const { sessionToken } = await repo.upsertUserByOAuth(
      { email: gu.email, googleId: gu.sub, referralCode: oauthState.ref, emailVerified: gu.email_verified === true || gu.email_verified === "true" },
      config.webSessionTtlMs
    );
    return redirect(`${config.siteUrl}/redeem.html#session=${sessionToken}`);
  } catch (err: any) {
    console.error("[freeai] google oauth:", err.message);
    return redirect(`${config.siteUrl}/redeem.html?login=error`);
  }
});

// ── Apple OAuth ──
route("GET", "/v1/auth/apple", async (ctx: any) => {
  if (!config.appleClientId) return redirect(`${config.siteUrl}/redeem.html?login=no-apple`);
  const params = new URLSearchParams({
    client_id: config.appleClientId, redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`,
    response_type: "code", scope: "email", response_mode: "query", state: makeOAuthState(ctx.query.get("ref")),
  });
  return redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});
route("GET", "/v1/auth/apple/callback", async (ctx: any) => {
  const query = ctx.query;
  if (query.get("error") || !query.get("code")) return redirect(`${config.siteUrl}/redeem.html?login=cancelled`);
  const oauthState = verifyOAuthState(query.get("state"));
  if (!oauthState) return redirect(`${config.siteUrl}/redeem.html?login=error`);
  try {
    const secret = buildAppleClientSecret();
    if (!secret) throw new Error("Apple credentials not configured");
    const tokRes = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: query.get("code"), client_id: config.appleClientId, client_secret: secret, redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`, grant_type: "authorization_code" }).toString(),
    });
    const tokens = await tokRes.json();
    if (!tokens.id_token) throw new Error("no id_token from Apple");
    const claims = decodeJwtPayload(tokens.id_token);
    if (!claims?.sub) throw new Error("no sub in Apple id_token");
    const { sessionToken } = await repo.upsertUserByOAuth(
      { email: claims.email || null, appleId: claims.sub, referralCode: oauthState.ref, emailVerified: claims.email_verified === true || claims.email_verified === "true" },
      config.webSessionTtlMs
    );
    return redirect(`${config.siteUrl}/redeem.html#session=${sessionToken}`);
  } catch (err: any) {
    console.error("[freeai] apple oauth:", err.message);
    return redirect(`${config.siteUrl}/redeem.html?login=error`);
  }
});

// ── website login + redemption ──
route("POST", "/v1/web/login", async (ctx: any) => {
  const body = ctx.body || {};
  if (!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return json(400, { error: "valid email required" });
  const token = await repo.createEmailToken(body.email, null, config.emailTokenTtlMs, body.referralCode);
  await mailer.sendWebLoginEmail(body.email, `${config.apiBaseUrl}/v1/web/session?token=${token}`);
  return json(200, { ok: true, sent: true });
});
route("GET", "/v1/web/session", async (ctx: any) => {
  const result = await repo.createWebSessionFromToken(ctx.query.get("token"), config.webSessionTtlMs);
  if (!result) return redirect(`${config.siteUrl}/redeem.html?login=expired`);
  return redirect(`${config.siteUrl}/redeem.html#session=${result.sessionToken}`);
});
route("GET", "/v1/web/me", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const bal = await repo.balanceForUser(user.id);
  return json(200, { email: user.email, balanceUsd: bal.balanceMillicents / 100000 });
});
route("GET", "/v1/web/earnings", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const window = ({ "24h": "24h", "7d": "7d", "30d": "30d" } as any)[ctx.query.get("window")] || "7d";
  const bucket = window === "24h" ? "hour" : "day";
  const sinceMs = window === "24h" ? 24 * 3600e3 : (window === "7d" ? 7 : 30) * 86400e3;
  const since = new Date(Date.now() - sinceMs);
  const e = await repo.earningsForUser(user.id);
  const series = await repo.earningsSeriesForUser(user.id, { bucket, since });
  return json(200, {
    todayUsd: e.todayMillicents / 100000, monthUsd: e.monthMillicents / 100000,
    lifetimeUsd: e.lifetimeMillicents / 100000, balanceUsd: e.balanceMillicents / 100000,
    redeemedUsd: e.redeemedMillicents / 100000, window,
    series: series.map((b: any) => ({ t: b.t, usd: b.millicents / 100000, count: b.count })),
  });
});
route("GET", "/v1/web/activity", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const rows = await repo.recentCreditsForUser(user.id, ctx.query.get("limit") || 200);
  return json(200, {
    count: rows.length,
    rows: rows.map((r: any) => ({
      id: String(r.id), createdAt: r.createdAt, type: r.entryType,
      amountUsd: r.amountMillicents / 100000, advertiser: r.advertiser, meta: r.meta,
    })),
  });
});
route("GET", "/v1/web/referrals", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const code = await repo.getOrCreateReferralCode(user.id);
  const stats = await repo.referralStats(user.id);
  return json(200, {
    code, link: `${config.siteUrl}/redeem.html?ref=${code}`,
    rewardUsd: config.referralRewardCents / 100, cap: config.referralCap,
    rewardedCount: stats.rewardedCount, pendingCount: stats.pendingCount,
    invitedCount: stats.invitedCount,
    creditsEarnedUsd: stats.creditsEarnedMillicents / 100000, referrals: stats.referrals,
  });
});
route("POST", "/v1/web/referrals/invite", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const email = String(ctx.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
    return json(400, { error: "you can't refer your own email" });
  }
  const code = await repo.getOrCreateReferralCode(user.id);
  const link = `${config.siteUrl}/redeem.html?ref=${code}`;
  const invite = await repo.createReferralInvite(user.id, email, code);
  await mailer.sendReferralInviteEmail(email, { inviterEmail: user.email, link, rewardUsd: config.referralRewardCents / 100 });
  return json(200, { ok: true, sent: true, invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at } });
});
route("POST", "/v1/web/redemptions", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const body = ctx.body || {};
  const plan = GIFT_PLANS[body.plan];
  const months = parseInt(body.months, 10);
  const amountCents = plan ? giftPriceCents(plan.id, months) : null;
  if (!amountCents) return json(400, { error: "plan must be pro/max5x/max20x and months 1/3/6/12" });
  const recipientEmail = body.recipientEmail || user.email;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) return json(400, { error: "valid recipientEmail required" });
  const balance = await repo.balanceForUser(user.id);
  if (balance.balanceMillicents < amountCents * 1000) return json(403, { error: "insufficient credits", balanceUsd: balance.balanceMillicents / 100000, requiredUsd: amountCents / 100 });
  const redemptionId = crypto.randomUUID();
  await mailer.sendGiftRedemptionEmail(config.giftFulfillmentEmail, { redemptionId, planName: plan.name, months, amountUsd: amountCents / 100, recipientEmail });
  const recorded = await repo.recordGiftRedemptionForUser({
    id: redemptionId, userId: user.id, plan: plan.id, months, amountCents, recipientEmail,
    referralRewardMillicents: config.referralRewardCents * 1000, referralCap: config.referralCap,
  });
  if (!recorded) return json(409, { error: "insufficient credits" });
  const after = await repo.balanceForUser(user.id);
  return json(200, { ok: true, redemptionId, plan: plan.id, months, amountUsd: amountCents / 100, balanceUsd: after.balanceMillicents / 100000, deliveryWindowHours: 48 });
});

// ── moderation ──
route("GET", "/v1/admin/campaigns", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { campaigns: await repo.pendingReviewCampaigns() });
});
route("POST", "/v1/admin/campaigns/approve", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const ok = await repo.approveCampaign(ctx.body?.campaignId);
  return json(ok ? 200 : 404, { ok });
});
route("POST", "/v1/admin/campaigns/reject", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.rejectCampaign(ctx.body?.campaignId, ctx.body?.note);
  if (!result) return json(404, { ok: false });
  if (result.paymentIntentId) {
    try { await stripe.createRefund({ payment_intent: result.paymentIntentId }); }
    catch (err: any) { console.error("[freeai] refund failed:", err.message); }
  }
  // Tell the advertiser their campaign was rejected + refunded. Wrapped so a
  // mail failure never fails the moderation action (already committed above).
  try {
    await mailer.sendCampaignRejectedEmail((result as any).email, {
      campaignId: ctx.body?.campaignId,
      brand: (result as any).brand,
      adLine: (result as any).adLine,
      pricePerBlockCents: (result as any).pricePerBlockCents,
      blocks: (result as any).blocks,
      note: (result as any).note,
    });
  } catch (err: any) {
    console.error("[freeai] rejection email failed:", err.message);
  }
  return json(200, { ok: true, refunded: !!result.paymentIntentId });
});
route("GET", "/admin", async (ctx: any) => {
  if (!adminOk(ctx)) return htmlResp(401, "<h1>401</h1><p>Append ?adminKey=…</p>");
  const list = await repo.pendingReviewCampaigns();
  const rows = list.map((c: any) => `
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
  return htmlResp(200, `<!doctype html><meta charset=utf-8><title>FreeAI moderation</title>
<style>body{font:14px system-ui;margin:40px;max-width:900px}table{width:100%;border-collapse:collapse}
td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}.line{font-family:monospace}
button{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
button.rej{border-color:#e33;color:#e33}h1{font-size:20px}</style>
<h1>Pending review (${list.length})</h1>
<table><tr><th>Brand</th><th>Ad line</th><th>URL</th><th>Bid</th><th></th></tr>${rows || '<tr><td colspan=5>Nothing to review 🎉</td></tr>'}</table>
<script>
const KEY=${JSON.stringify(ctx.query.get("adminKey") || "")};
const API=${JSON.stringify(config.apiBaseUrl)};
async function act(kind,id){
  const note = kind==='reject' ? prompt('Reason (optional):') || '' : '';
  await fetch(API+'/v1/admin/campaigns/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminKey:KEY,campaignId:id,note})});
  location.reload();
}
</script>`);
});

// ── killswitch & payouts ──
route("POST", "/v1/admin/killswitch", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.serving !== "boolean") return json(400, { error: "serving (boolean) required" });
  serving = ctx.body.serving; // per-isolate only (see header note)
  return json(200, { ok: true, serving });
});
route("POST", "/v1/admin/payouts", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, await runPayouts());
});

// ─────────────────────────────── dispatch ──────────────────────────────────
function stripPrefix(pathname: string) {
  let path = pathname.replace(/^\/functions\/v1/, ""); // defensive: platform prefix
  path = path.replace(/^\/api(?=\/|$)/, "");            // our function slug
  return path === "" ? "/" : path;
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const allowOrigin = resolveOrigin(req);
  // Stamp the per-request allowed origin onto every response we return.
  const withCors = (res: Response) => {
    res.headers.set("Access-Control-Allow-Origin", allowOrigin);
    res.headers.set("Vary", "Origin");
    return res;
  };
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Origin": allowOrigin, "Vary": "Origin" } });
  }

  const url = new URL(req.url);
  const path = stripPrefix(url.pathname);

  let handler = exact.get(`${req.method} ${path}`);
  const params: any = {};
  if (!handler) {
    for (const r of paramRoutes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.regex);
      if (m) { handler = r.handler; r.keys.forEach((k: string, i: number) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
    }
  }
  if (!handler) return withCors(json(404, { error: "not found" }));

  // read + size-cap the body
  const rawBody = await req.text();
  if (rawBody && Buffer.byteLength(rawBody) > config.maxBodyBytes) return withCors(json(413, { error: "payload too large" }));
  let body: any = null;
  if (rawBody) { try { body = JSON.parse(rawBody); } catch { return withCors(json(400, { error: "invalid json" })); } }

  const ctx = { req, headers: req.headers, body, rawBody, query: url.searchParams, params };
  try {
    return withCors(await handler(ctx));
  } catch (err: any) {
    console.error(`[freeai] ${req.method} ${path} failed:`, err?.message);
    lastError = { at: new Date().toISOString(), method: req.method, path, message: err?.message, stack: err?.stack };
    try { await pool.query("insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)", [req.method, path, String(err?.message || err), String(err?.stack || "")]); } catch (_e) { /* best-effort */ }
    return withCors(json(500, { error: "internal error" }));
  } finally {
    console.log(`[freeai] ${req.method} ${path} ${Date.now() - started}ms`);
  }
});
