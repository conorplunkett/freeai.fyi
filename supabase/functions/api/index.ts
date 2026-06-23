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

// Crew = the affiliate "earn with your friends" panel in the extension popup.
// Five slots: each is a joined friend, a pending invite, or an open invite form.
const CREW_SIZE = 5;

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
    affiliateRewardBps: parseInt(env("AFFILIATE_REWARD_BPS", "1000"), 10), // affiliate's cut, basis points (1000 = 10%)
    affiliateCapCents: parseInt(env("AFFILIATE_CAP_CENTS", "100000"), 10), // $1,000 total credits per affiliate
    giftFulfillmentEmail: env("GIFT_FULFILLMENT_EMAIL", "conor.p43@gmail.com"),
    emailTokenTtlMs: parseInt(env("EMAIL_TOKEN_TTL_MS", "1800000"), 10),
    emailCooldownMs: parseInt(env("EMAIL_COOLDOWN_MS", "60000"), 10), // min gap between magic-link sends per email; 0 disables. DB-backed, so it holds even though the in-memory rate limiter is dropped here.
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
        body: JSON.stringify({ from: cfg.mailFrom || "FreeAI <ads@contact.freeai.fyi>", to, subject, html: htmlBody }),
      });
      if (!res.ok) throw new Error("resend send failed: " + res.status + " " + (await res.text().catch(() => "")).slice(0, 300));
      return;
    }
    console.log(`[freeai][mail] to=${to} subject="${subject}"`);
  }
  // ── Branded shell for user-facing emails (sign-in, verify, invites,
  // redemption, reward). Table layout + inline styles so it renders across mail
  // clients; palette mirrors theme.css (Claude coral on cream). The advertiser
  // and admin notices further down keep their original plain layout on purpose. ──
  const FONT = "'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const site = cfg.siteUrl || "https://freeai.fyi";
  function button(href: string, label: string) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 6px;"><tr>`
      + `<td align="center" bgcolor="#d97757" style="border-radius:10px;background:#d97757;background:linear-gradient(180deg,#e08a6a,#cf6b4a);">`
      + `<a href="${href}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>`
      + `</td></tr></table>`;
  }
  function shell({ preheader = "", hero = "", heading = "", body = "", cta = null as any, note = "" }: any) {
    const btn = cta ? button(cta.href, cta.label) : "";
    const foot = note ? `<p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.55;color:#9b988f;">${note}</p>` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>`
      + `<body style="margin:0;padding:0;background:#faf9f5;">`
      + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#faf9f5;font-size:1px;line-height:1px;">${preheader}</div>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f5;"><tr><td align="center" style="padding:30px 16px;">`
      + `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:100%;">`
      + `<tr><td align="center" style="padding:2px 0 22px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`
      + `<td width="40" height="40" align="center" valign="middle" bgcolor="#d97757" style="width:40px;height:40px;border-radius:10px;background:#d97757;background:linear-gradient(180deg,#e08a6a,#cf6b4a);font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:18px;font-weight:800;color:#ffffff;">F$</td>`
      + `<td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#1f1e1d;">FreeAI.fyi</td>`
      + `</tr></table></td></tr>`
      + `<tr><td style="background:#ffffff;border:1px solid #e6e2d8;border-radius:16px;padding:34px 32px;">`
      + (hero ? `<div style="text-align:center;font-size:40px;line-height:1;margin:0 0 12px;">${hero}</div>` : "")
      + (heading ? `<h1 style="margin:0 0 16px;text-align:center;font-family:${FONT};font-size:21px;font-weight:800;letter-spacing:-0.02em;color:#1f1e1d;">${heading}</h1>` : "")
      + `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:#3d3b37;">${body}</div>${btn}${foot}`
      + `</td></tr>`
      + `<tr><td align="center" style="padding:22px 10px 6px;font-family:${FONT};font-size:12px;line-height:1.7;color:#9b988f;">`
      + `<a href="${site}" style="color:#c15f3c;text-decoration:none;font-weight:700;">freeai.fyi</a>`
      + `&nbsp;·&nbsp;<a href="${site}/terms" style="color:#9b988f;text-decoration:underline;">Terms</a>`
      + `&nbsp;·&nbsp;<a href="${site}/privacy" style="color:#9b988f;text-decoration:underline;">Privacy</a>`
      + `<br>Earn credits while you use Claude, ChatGPT &amp; Gemini.`
      + `</td></tr></table></td></tr></table></body></html>`;
  }
  // Key/value detail box for the campaign emails — same inset style as the
  // user-email tables, with hairline row separators. Falsy rows are dropped.
  function detail(rows: any[]) {
    const cells = rows.filter(Boolean).map(([k, v]: any, i: number) =>
      `<tr><td style="padding:8px 16px;font-family:${FONT};font-size:13px;color:#6b6963;${i ? "border-top:1px solid #efeae0;" : ""}">${k}</td>`
      + `<td style="padding:8px 16px;font-family:${FONT};font-size:13px;font-weight:600;color:#1f1e1d;text-align:right;${i ? "border-top:1px solid #efeae0;" : ""}">${v}</td></tr>`).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 2px;background:#faf9f5;border:1px solid #e6e2d8;border-radius:12px;">${cells}</table>`;
  }
  return {
    sendVerifyEmail: (to: string, link: string) => send(to, "Verify your email to get paid",
      shell({
        preheader: "Confirm your email to start receiving FreeAI payouts.",
        hero: "✅", heading: "Verify your email to get paid",
        body: `<p style="margin:0 0 14px;">Confirm this address so your FreeAI credits land in the right place. Once it's verified, every subtle sponsored line you see while using Claude, ChatGPT or Gemini pays you back in credits.</p>`,
        cta: { href: link, label: "Verify my email" },
        note: "This link expires in 30 minutes. If you didn't request it, you can safely ignore this email.",
      })),
    sendWebLoginEmail: (to: string, link: string) => send(to, "Your FreeAI sign-in link",
      shell({
        preheader: "Your secure FreeAI sign-in link — expires in 30 minutes.",
        hero: "🔑", heading: "Sign in to FreeAI",
        body: `<p style="margin:0 0 14px;">Tap the button below to sign in and manage your FreeAI credits — redeem them for Claude, ChatGPT or Gemini gift cards whenever you like.</p>`,
        cta: { href: link, label: "Sign in to FreeAI" },
        note: "This link expires in 30 minutes and can only be used once. If you didn't request it, ignore this email.",
      })),
    sendAdvertiserReceiptEmail: (to: string, { campaignId, brand, adLine, pricePerBlockCents, blocks }: any) =>
      send(to, "Your FreeAI campaign receipt",
      shell({
        preheader: "Your FreeAI campaign payment is confirmed — now in review.",
        hero: "💳", heading: "Payment confirmed",
        body: `<p style="margin:0 0 14px;">Thanks for advertising on FreeAI — your payment is confirmed and your campaign is in review.</p>`
          + detail([
            ["Ad line", `“${adLine}”`],
            brand ? ["Brand", brand] : null,
            ["Volume", `${blocks} block${blocks === 1 ? "" : "s"} · ${(blocks * 1000).toLocaleString("en-US")} impressions`],
            ["Price / block", `US$${(pricePerBlockCents / 100).toFixed(2)}`],
            ["Total paid", `US$${((pricePerBlockCents * blocks) / 100).toFixed(2)}`],
            ["Campaign", campaignId],
          ]),
        note: "It goes live once we approve it — usually within a day. Stripe has emailed a separate itemized receipt for your records.",
      })),
    sendCampaignLiveEmail: (to: string, { campaignId, brand, adLine, blocks }: any) =>
      send(to, "Your FreeAI ad is live 🎉",
      shell({
        preheader: "Approved — your ad is now live on FreeAI.",
        hero: "🚀", heading: "Your ad is live",
        body: `<p style="margin:0 0 14px;">Good news — your campaign is approved and now <strong style="color:#1f1e1d;">live on FreeAI</strong>. 🎉</p>`
          + detail([
            ["Ad line", `“${adLine}”`],
            brand ? ["Brand", brand] : null,
            ["Running", `${(blocks * 1000).toLocaleString("en-US")} impressions (${blocks} block${blocks === 1 ? "" : "s"})`],
            ["Campaign", campaignId],
          ]),
        note: "It's showing in the spinner while people use ChatGPT, Claude & Gemini. Higher bids serve first — come back any time to boost your bid and climb the leaderboard.",
      })),
    sendCampaignRejectedEmail: (to: string, { campaignId, brand, adLine, pricePerBlockCents, blocks, note }: any) =>
      send(to, "Your FreeAI campaign was refunded",
      shell({
        preheader: "Your FreeAI campaign wasn't approved — refunded in full.",
        hero: "💸", heading: "Your campaign was refunded",
        body: `<p style="margin:0 0 14px;">Thanks for your interest in advertising on FreeAI. We weren't able to approve this campaign, so we've refunded it in full.</p>`
          + detail([
            ["Ad line", `“${adLine}”`],
            brand ? ["Brand", brand] : null,
            ["Refunded", `US$${((pricePerBlockCents * blocks) / 100).toFixed(2)}`],
            ["Campaign", campaignId],
          ])
          + (note ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:14px;line-height:1.5;color:#3d3b37;"><strong style="color:#1f1e1d;">Reviewer note:</strong> ${note}</p>` : ""),
        note: "The refund returns to your original payment method; Stripe will email a separate confirmation. You're welcome to submit a new campaign any time.",
      })),
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
      shell({
        preheader: `${inviterEmail} invited you to FreeAI — earn free Claude credits.`,
        hero: "🎁", heading: "You're invited to FreeAI",
        body: `<p style="margin:0 0 14px;"><strong style="color:#1f1e1d;">${inviterEmail}</strong> is earning free Claude credits with FreeAI and wants you in.</p>`
          + `<p style="margin:0 0 14px;">FreeAI shows one subtle sponsored line while you use ChatGPT, Claude or Gemini, and pays you back <strong>50% of the revenue</strong> as Claude credits — cash out anytime for gift cards.</p>`,
        cta: { href: link, label: "Accept the invite" },
        note: `When you sign up with this link and redeem your first Claude gift card, ${inviterEmail} earns a one-time $${Math.round(rewardUsd)} bonus — at no cost to you.`,
      })),
    // Crew invite from the extension popup: the friend is attributed to the
    // inviter's affiliate code, so the inviter earns their cut of everything the
    // friend makes — forever. The friend keeps 100% of their own earnings.
    sendCrewInviteEmail: (to: string, { inviterEmail, link, rewardPct }: any) =>
      send(to, `${inviterEmail} added you to their FreeAI crew`,
      shell({
        preheader: `${inviterEmail} added you to their FreeAI crew — earn free Claude credits.`,
        hero: "🤝", heading: "Join your friend's FreeAI crew",
        body: `<p style="margin:0 0 14px;"><strong style="color:#1f1e1d;">${inviterEmail}</strong> is earning free Claude credits with FreeAI and added you to their crew.</p>`
          + `<p style="margin:0 0 14px;">FreeAI shows one subtle sponsored line while you use ChatGPT, Claude or Gemini, and pays you back <strong>50% of the revenue</strong> as Claude credits.</p>`,
        cta: { href: link, label: "Join the crew" },
        note: `You keep 100% of what you earn. ${inviterEmail} earns an extra ${Math.round(rewardPct)}% on top — at no cost to you.`,
      })),
    // Confirmation to the user who just redeemed credits for a Claude gift card
    // (the fulfillment inbox gets its own separate notice above).
    sendRedemptionConfirmationEmail: (to: string, { planName, months, amountUsd }: any) =>
      send(to, `Your Claude gift card is on the way — ${months} month${months > 1 ? "s" : ""} of ${planName}`,
      shell({
        preheader: `We got your redemption — ${months} month${months > 1 ? "s" : ""} of ${planName}.`,
        hero: "🧾", heading: "Your redemption is in",
        body: `<p style="margin:0 0 16px;">Nice work — you've cashed in your FreeAI credits for a Claude gift card. Here's what's on the way:</p>`
          + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f5;border:1px solid #e6e2d8;border-radius:12px;"><tr>`
          + `<td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:#3d3b37;"><strong style="color:#1f1e1d;">${planName}</strong> · ${months} month${months > 1 ? "s" : ""}<br><span style="color:#6b6963;">Value: US$${amountUsd.toFixed(2)} in Claude credits</span></td>`
          + `</tr></table>`,
        note: "We fulfill gift cards within 48 hours — keep an eye on your inbox for the Claude gift card.",
      })),
    // Sent to the referrer when a friend they referred redeems their first gift
    // card, which is what unlocks the one-time referral bonus.
    sendReferralRewardEmail: (to: string, { rewardUsd, link }: any) =>
      send(to, `You earned $${Math.round(rewardUsd)} in Claude credits 🎉`,
      shell({
        preheader: `You earned $${Math.round(rewardUsd)} in Claude credits from a referral.`,
        hero: "🎉", heading: `You earned $${Math.round(rewardUsd)} in credits!`,
        body: `<p style="margin:0 0 14px;">A friend you referred just redeemed their first Claude gift card on FreeAI — so we've added a one-time <strong style="color:#1f1e1d;">$${Math.round(rewardUsd)}</strong> bonus to your balance. 🙌</p>`
          + `<p style="margin:0 0 14px;">Keep inviting friends to stack up more credits.</p>`,
        cta: { href: link, label: "View your dashboard" },
        note: "Credits never expire — redeem them for Claude, ChatGPT or Gemini gift cards anytime.",
      })),
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
    // Surface the granted reward so the caller can email the referrer AFTER the
    // transaction commits — never send mail from inside the tx.
    const referrer = await client.query("select email from users where id = $1", [referrer_user_id]);
    return { referrerUserId: referrer_user_id, referrerEmail: referrer.rows[0]?.email || null, rewardMillicents };
  }

  // Attribute a user to an approved affiliate by code. Runs at signup OR
  // retroactively, but only when the user has no prior attribution (no referrer
  // and no affiliate) — the two are mutually exclusive. Self-attribution and
  // unknown/unapproved codes are ignored. Returns true when attributed.
  async function applyAffiliateCode(client: any, userId: string, code: any) {
    if (!code) return false;
    const norm = String(code).trim().toUpperCase();
    if (!norm) return false;
    const a = await client.query(
      "select id, user_id from affiliates where upper(code) = $1 and status = 'approved'",
      [norm]
    );
    const aff = a.rows[0];
    if (!aff || aff.user_id === userId) return false;
    const upd = await client.query(
      `update users set affiliate_id = $2
        where id = $1 and affiliate_id is null and referred_by is null
        returning id`,
      [userId, aff.id]
    );
    if (!upd.rows[0]) return false;
    await client.query(
      `insert into affiliate_attributions (affiliate_id, affiliated_user_id)
       values ($1, $2) on conflict (affiliated_user_id) do nothing`,
      [aff.id, userId]
    );
    return true;
  }

  // Resolve a signup code against both namespaces. Affiliate codes win (the
  // application-gated program); anything else falls through to referrals.
  async function applyCode(client: any, userId: string, code: any) {
    if (!code) return;
    const attributed = await applyAffiliateCode(client, userId, code);
    if (!attributed) await applyReferral(client, userId, code);
  }

  // Pay an affiliate their cut of an affiliated user's just-earned credits. The
  // affiliate row is locked FOR UPDATE so the running total can't be raced past
  // the cap. Platform-funded — the affiliated user keeps 100% of their earnings.
  async function creditAffiliate(client: any, affiliatedUserId: string | null, baseMillicents: any) {
    if (!affiliatedUserId) return;
    const base = BigInt(baseMillicents);
    if (base <= 0n) return;
    const a = await client.query(
      `select a.id, a.user_id, a.reward_bps, a.cap_millicents, a.credited_millicents
         from affiliates a
         join users u on u.affiliate_id = a.id
        where u.id = $1 and a.status = 'approved'
        for update of a`,
      [affiliatedUserId]
    );
    const aff = a.rows[0];
    if (!aff) return;
    const remaining = BigInt(aff.cap_millicents) - BigInt(aff.credited_millicents);
    if (remaining <= 0n) return;
    let share = (base * BigInt(aff.reward_bps)) / 10000n;
    if (share > remaining) share = remaining;
    if (share <= 0n) return;
    await client.query(
      `insert into ledger (entry_type, amount_millicents, user_id, meta)
       values ('affiliate_credit', $1, $2, $3)`,
      [share.toString(), aff.user_id, JSON.stringify({ affiliateId: aff.id, affiliatedUserId })]
    );
    await client.query(
      "update affiliates set credited_millicents = credited_millicents + $2 where id = $1",
      [aff.id, share.toString()]
    );
  }

  // Mint a unique affiliate code (unique across users.referral_code AND
  // affiliates.code) onto an affiliate row that has none yet; returns the code
  // (existing or freshly minted). Shared by approveAffiliate and the self-serve
  // getOrCreateAffiliate path so the two never drift.
  async function mintAffiliateCode(affiliateId: string) {
    const ex = await pool.query("select code from affiliates where id = $1", [affiliateId]);
    if (ex.rows[0]?.code) return ex.rows[0].code;
    for (let i = 0; i < 8; i++) {
      const cand = generateReferralCode();
      const clash = await pool.query(
        `select 1 from users where upper(referral_code) = $1
         union all select 1 from affiliates where upper(code) = $1`,
        [cand]
      );
      if (clash.rows[0]) continue;
      try {
        const r = await pool.query(
          "update affiliates set code = $2 where id = $1 and code is null returning code",
          [affiliateId, cand]
        );
        if (r.rows[0]) return r.rows[0].code;
        const re = await pool.query("select code from affiliates where id = $1", [affiliateId]);
        if (re.rows[0]?.code) return re.rows[0].code;
      } catch (err: any) {
        if (err.code === "23505") continue;
        throw err;
      }
    }
    throw new Error("could not allocate affiliate code");
  }

  // Ensure the user is enrolled as an APPROVED affiliate with a code (self-serve,
  // no social application), idempotently; returns { id, code }. Shared by the
  // device popup path and the web dashboard so everyone has a base 10% link.
  async function ensureAffiliate(userId: string) {
    const ins = await pool.query(
      `insert into affiliates (user_id, status, approved_at)
       values ($1, 'approved', now())
       on conflict (user_id) do nothing
       returning id`,
      [userId]
    );
    let id = ins.rows[0]?.id;
    if (!id) {
      const ex = await pool.query("select id, status from affiliates where user_id = $1", [userId]);
      id = ex.rows[0].id;
      if (ex.rows[0].status !== "approved") {
        await pool.query(
          "update affiliates set status = 'approved', approved_at = coalesce(approved_at, now()) where id = $1",
          [id]
        );
      }
    }
    const code = await mintAffiliateCode(id);
    return { id, code };
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
        `update campaigns cmp set status = 'active', activated_at = now()
           from advertisers adv
          where cmp.id = $1 and cmp.status = 'pending_review'
            and adv.id = cmp.advertiser_id
          returning adv.email, cmp.brand, cmp.ad_line, cmp.price_per_block_cents, cmp.blocks`,
        [campaignId]
      );
      const r = rows[0];
      return r ? { email: r.email, brand: r.brand, adLine: r.ad_line, pricePerBlockCents: r.price_per_block_cents, blocks: r.blocks } : null;
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
    async ingestBatch({ deviceId, batchKey, events, source, revenueShare, dailyCap, ipHash, ipDailyCap }: any) {
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
            [dev.toString(), deviceId, ev.campaignId, JSON.stringify(source ? { impressions: imp, billed, source } : { impressions: imp, billed })]
          );
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('platform_fee', $1, $2, '{}')`,
            [fee.toString(), ev.campaignId]
          );
        }
        // If this device's user was attributed to an affiliate, accrue the
        // affiliate's cut (platform-funded, on top) on the batch's net credit.
        if (credited > 0n) {
          const dev = await c.query("select user_id from devices where id = $1", [deviceId]);
          await creditAffiliate(c, dev.rows[0]?.user_id, credited);
        }
        return { duplicate: false, creditedMillicents: Number(credited) };
      });
    },
    async earningsForDevice(deviceId: string) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit')), 0)::bigint as earned,
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
    async createEmailToken(email: string, deviceId: string | null, ttlMs: number, referralCode?: any, cooldownMs?: number) {
      // Per-email send cooldown: collapse rapid repeat requests so the magic-link
      // endpoints can't be used to email-bomb or probe an address. Scoped by
      // device so verify-email (device-linked) and website-login (device-null)
      // never throttle each other. Returns null when a fresh token was just
      // issued — the caller responds the same either way so nothing leaks.
      if (cooldownMs) {
        const recent = await pool.query(
          `select 1 from email_tokens
            where lower(email) = lower($1) and used_at is null
              and device_id is not distinct from $2
              and created_at > now() - ($3 || ' milliseconds')::interval
            limit 1`,
          [email, deviceId || null, String(cooldownMs)]
        );
        if (recent.rows[0]) return null;
      }
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
    // Link a device to a user (self-serve, from the freeai.fyi web session). Same
    // association the magic-link verify makes — balance queries already roll up
    // "this user OR any device linked to them", so no balance merge is needed.
    async linkDeviceToUser(deviceId: string, userId: string) {
      await pool.query("update devices set user_id = $2 where id = $1", [deviceId, userId]);
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
          // Accrue the affiliate's cut on this click credit, if any.
          const dev2 = await c.query("select user_id from devices where id = $1", [device_id]);
          await creditAffiliate(c, dev2.rows[0]?.user_id, dev);
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
          await applyCode(c, userId, referralCode);
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
        if (u.rows[0].is_new) await applyCode(c, u.rows[0].id, t.rows[0].referral_code);
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
    async deleteWebSession(sessionToken: string | null) {
      if (!sessionToken) return;
      await pool.query("delete from web_sessions where token = $1", [sessionToken]);
    },
    async balanceForUser(userId: string) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit')), 0)::bigint as earned,
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
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit') and created_at >= date_trunc('day', now())), 0)::bigint as today,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit') and created_at >= date_trunc('month', now())), 0)::bigint as month,
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
           and entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit')
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
            and l.entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit')
          order by l.created_at desc limit $2`,
        [userId, n]
      );
      return rows.map((r: any) => ({
        id: r.id, createdAt: r.created_at, entryType: r.entry_type,
        amountMillicents: Number(r.amount_millicents), advertiser: r.brand || null, meta: r.meta || {},
      }));
    },
    // Which surfaces this account has ever received a credit from, read from the
    // source tag stamped on impression credits at ingest. Drives the Install
    // tab's per-service "active" logo (grey → colored on the first credit).
    async sourcesForUser(userId: string) {
      const { rows } = await pool.query(
        `select distinct meta->>'source' as source
           from ledger
          where (user_id = $1 or device_id in (select id from devices where user_id = $1))
            and entry_type in ('impression_credit','click_credit')
            and meta->>'source' is not null`,
        [userId]
      );
      const seen = new Set(rows.map((r: any) => r.source));
      return { chrome: seen.has("chrome"), claude_code: seen.has("claude_code"), desktop: seen.has("desktop") };
    },
    async recordGiftRedemptionForUser({ id, userId, plan, months, amountCents, recipientEmail, referralRewardMillicents, referralCap }: any) {
      return tx(async (c: any) => {
        await c.query("select pg_advisory_xact_lock($1, hashtext($2))", [LOCK_REDEEM, `user:${userId}`]);
        const bal = await c.query(
          `select coalesce(sum(amount_millicents), 0)::bigint as balance from ledger
            where (user_id = $1 or device_id in (select id from devices where user_id = $1))
              and entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','payout_debit','gift_redemption_debit')`,
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
        let reward = null;
        if (referralRewardMillicents) reward = await maybeRewardReferral(c, userId, referralRewardMillicents, referralCap ?? 10);
        return { id: rows[0].id, reward };
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
    // Pending crew invites (email sent, friend hasn't signed up yet) for the
    // device-scoped affiliate panel in the extension. Masked emails only — the
    // full address never leaves the server. Friends who've already joined are
    // filtered out by the caller (they surface via affiliateCrew instead).
    async pendingInvitesForUser(userId: string) {
      const r = await pool.query(
        `select email, sent_at from referral_invites
          where referrer_user_id = $1 and status = 'sent'
          order by sent_at asc limit 20`,
        [userId]
      );
      return r.rows.map((row: any) => ({ email: maskEmail(row.email), invitedAt: row.sent_at }));
    },
    // First-login onboarding gate: true once the user has referred anyone — either
    // sent at least one invite, or has a friend who joined with their code. Drives
    // the "refer a friend to start earning" screen the new user must clear before
    // reaching their dashboard.
    async hasReferredAnyone(userId: string) {
      const r = await pool.query(
        `select exists(select 1 from referral_invites where referrer_user_id = $1)
             or exists(select 1 from referrals where referrer_user_id = $1) as referred`,
        [userId]
      );
      return r.rows[0]?.referred === true;
    },

    // First-login survey: true once the user has answered the "what models /
    // where do you use them" questions. Drives the needsSurvey gate on
    // /v1/web/me, shown before the refer-a-friend step.
    async hasOnboardingSurvey(userId: string) {
      const r = await pool.query("select 1 from onboarding_surveys where user_id = $1", [userId]);
      return r.rowCount > 0;
    },
    // Upsert the survey answers (idempotent — re-answering overwrites). Arrays
    // are stored as jsonb; surfaceOther is the free text for the "other" surface.
    async saveOnboardingSurvey(userId: string, { models, surfaces, surfaceOther }: any) {
      await pool.query(
        `insert into onboarding_surveys (user_id, models, surfaces, surface_other)
           values ($1, $2::jsonb, $3::jsonb, $4)
         on conflict (user_id) do update
           set models = excluded.models, surfaces = excluded.surfaces,
               surface_other = excluded.surface_other, updated_at = now()`,
        [userId, JSON.stringify(models), JSON.stringify(surfaces), surfaceOther]
      );
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
    // ---------- affiliates ----------
    async submitAffiliateApplication(userId: string, socials: any) {
      const s = socials || {};
      const { rows } = await pool.query(
        `insert into affiliates
           (user_id, instagram_handle, instagram_followers,
            linkedin_handle, linkedin_followers, twitter_handle, twitter_followers)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (user_id) do nothing
         returning id, status`,
        [userId, s.instagram || null, s.instagramFollowers ?? null,
         s.linkedin || null, s.linkedinFollowers ?? null,
         s.twitter || null, s.twitterFollowers ?? null]
      );
      return rows[0] || null;
    },
    async affiliateForUser(userId: string) {
      const u = await pool.query("select affiliate_id, referred_by from users where id = $1", [userId]);
      const attributed = !!u.rows[0]?.affiliate_id;
      const hasReferrer = !!u.rows[0]?.referred_by;
      const a = await pool.query(
        `select id, status, code, instagram_handle, instagram_followers,
                linkedin_handle, linkedin_followers, twitter_handle, twitter_followers,
                reward_bps, cap_millicents, credited_millicents, created_at, approved_at
           from affiliates where user_id = $1`,
        [userId]
      );
      if (!a.rows[0]) return { application: null, attributed, hasReferrer };
      const aff = a.rows[0];
      let attributedCount = 0;
      if (aff.status === "approved") {
        const cnt = await pool.query(
          "select count(*)::int as n from affiliate_attributions where affiliate_id = $1",
          [aff.id]
        );
        attributedCount = cnt.rows[0].n;
      }
      return {
        attributed, hasReferrer,
        application: {
          status: aff.status, code: aff.code,
          socials: {
            instagram: aff.instagram_handle, instagramFollowers: aff.instagram_followers,
            linkedin: aff.linkedin_handle, linkedinFollowers: aff.linkedin_followers,
            twitter: aff.twitter_handle, twitterFollowers: aff.twitter_followers,
          },
          rewardBps: aff.reward_bps,
          capMillicents: Number(aff.cap_millicents),
          creditedMillicents: Number(aff.credited_millicents),
          attributedCount, createdAt: aff.created_at, approvedAt: aff.approved_at,
        },
      };
    },
    async applyAffiliateCodeForUser(userId: string, code: any) {
      return tx(async (c: any) => {
        const u = await c.query("select affiliate_id, referred_by from users where id = $1 for update", [userId]);
        if (u.rows[0]?.affiliate_id) return { ok: false, reason: "already_affiliated" };
        if (u.rows[0]?.referred_by) return { ok: false, reason: "has_referrer" };
        const ok = await applyAffiliateCode(c, userId, code);
        return { ok, reason: ok ? null : "invalid_code" };
      });
    },
    async listAffiliateApplications() {
      const { rows } = await pool.query(
        `select a.id, a.status, a.code, u.email,
                a.instagram_handle, a.instagram_followers,
                a.linkedin_handle, a.linkedin_followers,
                a.twitter_handle, a.twitter_followers,
                a.reward_bps, a.cap_millicents, a.credited_millicents,
                a.review_note, a.created_at, a.approved_at,
                (select count(*)::int from affiliate_attributions aa where aa.affiliate_id = a.id) as attributed_count
           from affiliates a join users u on u.id = a.user_id
          order by case a.status when 'pending' then 0 when 'approved' then 1 else 2 end,
                   a.created_at desc`
      );
      return rows;
    },
    async approveAffiliate(affiliateId: string) {
      const existing = await pool.query("select id from affiliates where id = $1", [affiliateId]);
      if (!existing.rows[0]) return null;
      const code = await mintAffiliateCode(affiliateId);
      const upd = await pool.query(
        `update affiliates set status = 'approved', approved_at = coalesce(approved_at, now()),
            review_note = null where id = $1 returning id`,
        [affiliateId]
      );
      return upd.rows[0] ? { id: affiliateId, code } : null;
    },
    // Self-serve affiliate enrollment: every signed-in earner is an approved
    // affiliate (base 10%) with a code — no social application, no admin review.
    async getOrCreateAffiliate(userId: string) {
      return ensureAffiliate(userId);
    },
    // Influencer upgrade request: the user keeps their active base 10% while
    // attaching socials so an admin can grant a higher rate / uncapped earnings /
    // a custom code. Records the socials on the (auto-created) affiliate row; the
    // presence of any handle is the "upgrade requested" signal the dashboard reads.
    async requestAffiliateUpgrade(userId: string, socials: any) {
      await ensureAffiliate(userId);
      const s = socials || {};
      await pool.query(
        `update affiliates set
           instagram_handle = $2, instagram_followers = $3,
           linkedin_handle = $4, linkedin_followers = $5,
           twitter_handle = $6, twitter_followers = $7
         where user_id = $1`,
        [userId, s.instagram || null, s.instagramFollowers ?? null,
         s.linkedin || null, s.linkedinFollowers ?? null,
         s.twitter || null, s.twitterFollowers ?? null]
      );
    },
    // Per-friend crew breakdown for an affiliate: each attributed friend, the
    // credits they've generated, and the affiliate's 10% cut earned from them.
    async affiliateCrew(affiliateId: string, affiliateUserId: string) {
      const credited = await pool.query(
        "select coalesce(sum(amount_millicents), 0)::bigint as c from ledger where entry_type = 'affiliate_credit' and user_id = $1",
        [affiliateUserId]
      );
      const { rows } = await pool.query(
        `select u.email,
          coalesce((select sum(amount_millicents) from ledger l
                     where l.entry_type in ('impression_credit','click_credit')
                       and (l.user_id = aa.affiliated_user_id
                            or l.device_id in (select id from devices where user_id = aa.affiliated_user_id))), 0)::bigint as generated,
          coalesce((select sum(amount_millicents) from ledger l
                     where l.entry_type = 'affiliate_credit' and l.user_id = $2
                       and l.meta->>'affiliatedUserId' = aa.affiliated_user_id::text), 0)::bigint as your_cut
         from affiliate_attributions aa
         join users u on u.id = aa.affiliated_user_id
        where aa.affiliate_id = $1
        order by aa.created_at asc
        limit 50`,
        [affiliateId, affiliateUserId]
      );
      return {
        count: rows.length,
        creditedMillicents: Number(credited.rows[0].c),
        friends: rows.map((r: any) => ({
          name: maskEmail(r.email),
          generatedUsd: Number(r.generated) / 100000,
          youUsd: Number(r.your_cut) / 100000,
        })),
      };
    },
    async rejectAffiliate(affiliateId: string, note: string) {
      const { rows } = await pool.query(
        "update affiliates set status = 'rejected', review_note = $2 where id = $1 returning id",
        [affiliateId, note || null]
      );
      return rows[0] || null;
    },
    // Admin grants an influencer upgrade: a custom rate (reward_bps), a raised /
    // uncapped cap, and optionally a vanity code. Stays 'approved' so the cut
    // keeps flowing. rewardBps/capMillicents are validated by the route.
    async grantAffiliateUpgrade(affiliateId: string, opts: any) {
      const ex = await pool.query("select id, code from affiliates where id = $1", [affiliateId]);
      if (!ex.rows[0]) return { ok: false, error: "not found" };
      let newCode: string | null = null;
      if (opts.code != null && String(opts.code).trim() !== "") {
        newCode = String(opts.code).trim().toUpperCase();
        if (!/^[A-Z0-9]{3,16}$/.test(newCode)) return { ok: false, error: "code must be 3–16 letters or numbers" };
        if (newCode !== ex.rows[0].code) {
          const clash = await pool.query(
            `select 1 from users where upper(referral_code) = $1
              union all select 1 from affiliates where upper(code) = $1 and id <> $2`,
            [newCode, affiliateId]
          );
          if (clash.rows[0]) return { ok: false, error: "that code is already taken" };
        }
      }
      const upd = await pool.query(
        `update affiliates set status = 'approved', approved_at = coalesce(approved_at, now()),
            reward_bps = $2, cap_millicents = $3, code = coalesce($4, code), review_note = null
          where id = $1
          returning id, reward_bps, cap_millicents, code`,
        [affiliateId, opts.rewardBps, String(opts.capMillicents), newCode]
      );
      return { ok: true, affiliate: upd.rows[0] };
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
    async listWaitlistSurfaces() {
      const { rows } = await pool.query("select surface, label from waitlist_surfaces order by sort_order asc, surface asc");
      return rows;
    },
    async joinWaitlist(userId: string, surface: string) {
      const { rows } = await pool.query(
        `insert into waitlist_signups (user_id, surface) values ($1, $2)
         on conflict (user_id, surface) do nothing returning id`,
        [userId, surface]
      );
      return !!rows[0];
    },
    async waitlistsForUser(userId: string) {
      const { rows } = await pool.query(
        "select surface, created_at from waitlist_signups where user_id = $1 order by created_at asc",
        [userId]
      );
      return rows;
    },

    // ────────────────────────── admin dashboard ───────────────────────────────
    // Persistent key/value settings (e.g. the killswitch). Best-effort: callers
    // wrap in try/catch so a missing `settings` table never breaks ad serving.
    async getSetting(key: string) {
      const { rows } = await pool.query("select value from settings where key = $1", [key]);
      return rows[0] ? rows[0].value : null;
    },
    async setSetting(key: string, value: any) {
      await pool.query(
        `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    },

    // Advertiser pricing knobs (admin-tunable, all in cents). Best-effort: a
    // missing `settings` table/row falls back to defaults so checkout never
    // breaks. minBid is floored at 50 (Stripe's USD minimum).
    async getPricing() {
      const defaults = { minBidCents: 50, suggestedBidCents: 500, topBidAnchorCents: 11000 };
      try {
        const { rows } = await pool.query("select value from settings where key = 'pricing'");
        const v = (rows[0] && rows[0].value) || {};
        const pick = (n: any, d: number) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : d);
        return {
          minBidCents: Math.max(50, pick(v.minBidCents, defaults.minBidCents)),
          suggestedBidCents: pick(v.suggestedBidCents, defaults.suggestedBidCents),
          topBidAnchorCents: Math.max(0, pick(v.topBidAnchorCents, defaults.topBidAnchorCents)),
        };
      } catch { return defaults; }
    },
    async setPricing(next: any) {
      await pool.query(
        `insert into settings (key, value, updated_at) values ('pricing', $1::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [JSON.stringify(next)]
      );
    },
    // Highest bid among currently-active campaigns (0 if none). Drives the
    // live-override half of the lander's "top bid".
    async topActiveBidCents() {
      try {
        const { rows } = await pool.query("select coalesce(max(price_per_block_cents),0)::int as top from campaigns where status = 'active'");
        return rows[0]?.top || 0;
      } catch { return 0; }
    },

    // KPI tiles + counts for the Overview tab. All money returned as raw
    // millicents (ledger) or cents (gift_redemptions); the edge route converts.
    async adminOverview() {
      const money = (await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type='campaign_credit'),0)::bigint as campaign_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='campaign_refund'),0)::bigint as campaign_refund,
           coalesce(sum(amount_millicents) filter (where entry_type='platform_fee'),0)::bigint as platform_fee,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit')),0)::bigint as dev_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='referral_credit'),0)::bigint as referral_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='affiliate_credit'),0)::bigint as affiliate_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='payout_debit'),0)::bigint as payout_debit,
           coalesce(sum(amount_millicents) filter (where entry_type='gift_redemption_debit'),0)::bigint as redemption_debit,
           coalesce(sum(amount_millicents) filter (where entry_type in ('admin_credit','admin_debit')),0)::bigint as admin_adjust,
           coalesce(sum(amount_millicents) filter (where entry_type in
             ('impression_credit','click_credit','referral_credit','affiliate_credit','admin_credit','admin_debit','payout_debit','gift_redemption_debit')),0)::bigint as liability
         from ledger`
      )).rows[0];
      const counts = (await pool.query(
        `select
           (select count(*) from users)::int as users,
           (select count(*) from users where email is not null)::int as users_with_email,
           (select count(*) from devices)::int as devices,
           (select count(*) from devices where last_seen_at >= now() - interval '1 day')::int as devices_active_1d,
           (select count(*) from advertisers)::int as advertisers,
           (select count(*) from campaigns)::int as campaigns,
           (select count(*) from campaigns where status='active')::int as campaigns_active,
           (select count(*) from campaigns where status='pending_review')::int as campaigns_pending,
           (select count(*) from gift_redemptions)::int as redemptions,
           (select count(*) from gift_redemptions where status='pending')::int as redemptions_pending,
           (select coalesce(sum(amount_cents),0) from gift_redemptions where status='pending')::bigint as redemptions_pending_cents,
           (select count(*) from referrals)::int as referrals,
           (select coalesce(sum(impressions),0) from event_batches)::bigint as impressions,
           (select coalesce(sum(clicks),0) from event_batches)::bigint as clicks`
      )).rows[0];
      const byStatus = (await pool.query(
        "select status, count(*)::int as n from campaigns group by status order by status"
      )).rows;
      return { money, counts, campaignsByStatus: byStatus };
    },

    // One bucket per UTC day, merged across tables in JS by the route.
    async adminDailyMetrics(days: number) {
      const d = Math.max(1, Math.min(365, days || 30));
      const events = (await pool.query(
        `select date_trunc('day', created_at) as d, sum(impressions)::bigint as imp, sum(clicks)::bigint as clk
           from event_batches where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const ledger = (await pool.query(
        `select date_trunc('day', created_at) as d,
                coalesce(sum(amount_millicents) filter (where entry_type='campaign_credit'),0)::bigint as bought,
                coalesce(sum(amount_millicents) filter (where entry_type='platform_fee'),0)::bigint as fee,
                coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit')),0)::bigint as dev
           from ledger where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const users = (await pool.query(
        `select date_trunc('day', created_at) as d, count(*)::int as n
           from users where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const devices = (await pool.query(
        `select date_trunc('day', created_at) as d, count(*)::int as n
           from devices where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const redemptions = (await pool.query(
        `select date_trunc('day', created_at) as d, count(*)::int as n, coalesce(sum(amount_cents),0)::bigint as cents
           from gift_redemptions where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      return { days: d, events, ledger, users, devices, redemptions };
    },

    async adminCampaigns({ status, limit, offset }: any) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const filters: string[] = [];
      const params: any[] = [];
      if (status) { params.push(status); filters.push(`c.status = $${params.length}`); }
      const where = filters.length ? `where ${filters.join(" and ")}` : "";
      params.push(n); const lim = `$${params.length}`;
      params.push(off); const ofs = `$${params.length}`;
      const { rows } = await pool.query(
        `select c.id, c.brand, c.ad_line, c.url, c.category, c.status,
                c.price_per_block_cents, c.blocks, c.impressions_total, c.impressions_remaining,
                (c.impressions_total - c.impressions_remaining) as impressions_served,
                c.show_on_leaderboard, c.review_note, c.created_at, c.paid_at, c.activated_at,
                a.email as advertiser_email,
                coalesce((select sum(amount_millicents) from ledger
                          where campaign_id = c.id and entry_type in ('impression_credit','click_credit','platform_fee')),0)::bigint as recognized_millicents
           from campaigns c left join advertisers a on a.id = c.advertiser_id
           ${where}
          order by c.created_at desc limit ${lim} offset ${ofs}`,
        params
      );
      return rows;
    },
    async cancelCampaign(campaignId: string) {
      if (!isUuid(campaignId)) return false;
      const { rows } = await pool.query(
        `update campaigns set status='cancelled'
          where id=$1 and status in ('active','pending_review','pending_payment') returning id`,
        [campaignId]
      );
      return !!rows[0];
    },

    async adminRedemptions({ status, limit }: any) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
      const params: any[] = [];
      let where = "";
      if (status) { params.push(status); where = `where g.status = $${params.length}`; }
      params.push(n);
      const { rows } = await pool.query(
        `select g.id, g.plan, g.months, g.amount_cents, g.recipient_email, g.status, g.created_at,
                g.user_id, g.device_id, u.email as user_email
           from gift_redemptions g left join users u on u.id = g.user_id
           ${where}
          order by g.created_at desc limit $${params.length}`,
        params
      );
      return rows;
    },
    // Set a redemption's status. When cancelling with refund=true, restore the
    // user's/device's balance via an admin_credit equal to the original debit.
    async setRedemptionStatus(id: string, status: string, refund: boolean) {
      if (!isUuid(id)) return null;
      if (!["pending", "fulfilled", "cancelled"].includes(status)) return null;
      return tx(async (c: any) => {
        const { rows } = await c.query(
          "update gift_redemptions set status=$2 where id=$1 returning user_id, device_id, amount_cents, status, recipient_email",
          [id, status]
        );
        if (!rows[0]) return null;
        let refunded = false;
        if (status === "cancelled" && refund) {
          const mc = (BigInt(rows[0].amount_cents) * 1000n).toString();
          await c.query(
            `insert into ledger (entry_type, amount_millicents, user_id, device_id, meta)
             values ('admin_credit', $1, $2, $3, $4)`,
            [mc, rows[0].user_id || null, rows[0].device_id || null, JSON.stringify({ reason: "redemption_cancelled", redemptionId: id })]
          );
          refunded = true;
        }
        return { ...rows[0], refunded };
      });
    },

    async adminUsers({ search, limit, offset }: any) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const params: any[] = [];
      let where = "";
      if (search) { params.push(`%${search}%`); where = `where u.email ilike $${params.length}`; }
      params.push(n); const lim = `$${params.length}`;
      params.push(off); const ofs = `$${params.length}`;
      const { rows } = await pool.query(
        `select u.id, u.email, u.email_verified, u.payouts_enabled, u.stripe_account_id,
                u.referral_code, u.referred_by, u.created_at,
                (select count(*) from devices d where d.user_id = u.id)::int as devices,
                coalesce((select sum(amount_millicents) from ledger l
                          where l.user_id = u.id or l.device_id in (select id from devices where user_id = u.id)),0)::bigint as balance_millicents,
                coalesce((select sum(amount_millicents) from ledger l
                          where (l.user_id = u.id or l.device_id in (select id from devices where user_id = u.id))
                            and l.entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit')),0)::bigint as earned_millicents
           from users u ${where}
          order by u.created_at desc limit ${lim} offset ${ofs}`,
        params
      );
      return rows;
    },

    async adminEmails() {
      const { rows } = await pool.query(
        `select email, source, created_at from (
           select email, 'user' as source, created_at from users where email is not null
           union all
           select email, 'advertiser' as source, created_at from advertisers where email is not null
           union all
           select recipient_email as email, 'redemption_recipient' as source, created_at from gift_redemptions where recipient_email is not null
         ) e order by created_at desc`
      );
      return rows;
    },

    async adminIncome() {
      const byType = (await pool.query(
        "select entry_type, count(*)::int as n, coalesce(sum(amount_millicents),0)::bigint as total from ledger group by entry_type order by entry_type"
      )).rows;
      return byType;
    },

    async adminPayoutsList() {
      const { rows } = await pool.query(
        `select p.id, p.user_id, p.amount_cents, p.status, p.stripe_transfer_id, p.created_at, u.email
           from payouts p left join users u on u.id = p.user_id
          order by p.created_at desc limit 200`
      );
      return rows;
    },

    async adminReferrals() {
      const byStatus = (await pool.query(
        "select status, count(*)::int as n, coalesce(sum(reward_millicents),0)::bigint as reward from referrals group by status order by status"
      )).rows;
      const top = (await pool.query(
        `select r.referrer_user_id, u.email, count(*)::int as referred,
                count(*) filter (where r.status='rewarded')::int as rewarded,
                coalesce(sum(r.reward_millicents),0)::bigint as reward_millicents
           from referrals r left join users u on u.id = r.referrer_user_id
          group by r.referrer_user_id, u.email order by referred desc limit 50`
      )).rows;
      return { byStatus, top };
    },

    async adminDevices(dailyImpCap: number, dailyClickCap: number) {
      const totals = (await pool.query(
        `select count(*)::int as total,
                count(*) filter (where last_seen_at >= now()-interval '1 day')::int as active_1d,
                count(*) filter (where last_seen_at >= now()-interval '7 days')::int as active_7d,
                count(*) filter (where user_id is not null)::int as linked
           from devices`
      )).rows[0];
      const heavyDevices = (await pool.query(
        `select device_id, sum(impressions)::bigint as imp, sum(clicks)::bigint as clk
           from event_batches where created_at >= date_trunc('day', now())
          group by device_id having sum(impressions) >= $1 or sum(clicks) >= $2
          order by imp desc limit 50`, [dailyImpCap, dailyClickCap]
      )).rows;
      const heavyIps = (await pool.query(
        `select ip_hash, count(distinct device_id)::int as devices, sum(impressions)::bigint as imp
           from event_batches where created_at >= date_trunc('day', now()) and ip_hash is not null
          group by ip_hash having sum(impressions) >= $1 order by imp desc limit 50`, [dailyImpCap]
      )).rows;
      return { totals, heavyDevices, heavyIps };
    },

    // Live schema introspection: every public table with its columns + exact
    // row count. Powers the Schema tab.
    async adminSchema() {
      const cols = (await pool.query(
        `select table_name, column_name, data_type, is_nullable, ordinal_position
           from information_schema.columns where table_schema='public'
          order by table_name, ordinal_position`
      )).rows;
      const tbls = (await pool.query(
        "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name"
      )).rows;
      const out: any[] = [];
      for (const t of tbls) {
        const name = t.table_name;
        if (!/^[a-z_][a-z0-9_]*$/i.test(name)) continue; // guard the interpolated identifier
        let count: number | null = null;
        try { count = Number((await pool.query(`select count(*)::bigint as n from "${name}"`)).rows[0].n); } catch { count = null; }
        out.push({
          table: name,
          rowCount: count,
          columns: cols.filter((c: any) => c.table_name === name)
            .map((c: any) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES" })),
        });
      }
      return out;
    },

    async adminLedgerAdjust({ userId, deviceId, amountCents, direction, note }: any) {
      const cents = Math.abs(parseInt(amountCents, 10) || 0);
      if (!cents) return null;
      if (userId && !isUuid(userId)) return null;
      if (deviceId && !isUuid(deviceId)) return null;
      if (!userId && !deviceId) return null;
      const isCredit = direction !== "debit";
      const entryType = isCredit ? "admin_credit" : "admin_debit";
      const mc = (BigInt(cents) * 1000n) * (isCredit ? 1n : -1n);
      const { rows } = await pool.query(
        `insert into ledger (entry_type, amount_millicents, user_id, device_id, meta)
         values ($1, $2, $3, $4, $5) returning id`,
        [entryType, mc.toString(), userId || null, deviceId || null, JSON.stringify({ note: note || null, source: "admin" })]
      );
      return rows[0]?.id || null;
    },

    // Referral invites funnel: emails a referrer invited, and how far each got
    // (sent -> joined -> rewarded).
    async adminInvites(limit = 200) {
      const byStatus = (await pool.query(
        "select status, count(*)::int as n from referral_invites group by status order by status"
      )).rows;
      const recent = (await pool.query(
        `select i.email, i.status, i.code, i.created_at, i.sent_at, i.joined_at, i.rewarded_at,
                u.email as referrer_email
           from referral_invites i left join users u on u.id = i.referrer_user_id
          order by i.created_at desc limit $1`,
        [Math.max(1, Math.min(500, limit))]
      )).rows;
      return { byStatus, recent };
    },

    // Waitlist demand per surface + recent signups (who's waiting for what).
    async adminWaitlist(limit = 200) {
      const bySurface = (await pool.query(
        `select s.surface, s.label, count(w.id)::int as n
           from waitlist_surfaces s left join waitlist_signups w on w.surface = s.surface
          group by s.surface, s.label, s.sort_order order by s.sort_order asc, s.surface asc`
      )).rows;
      const recent = (await pool.query(
        `select w.surface, w.created_at, u.email
           from waitlist_signups w left join users u on u.id = w.user_id
          order by w.created_at desc limit $1`,
        [Math.max(1, Math.min(500, limit))]
      )).rows;
      return { bySurface, recent };
    },

    // Most recent runtime errors captured by the dispatch handler.
    async adminErrors(limit = 100) {
      const { rows } = await pool.query(
        "select id, method, path, message, created_at from diag_errors order by created_at desc limit $1",
        [Math.max(1, Math.min(500, limit))]
      );
      return rows;
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
// Ad-serving killswitch. Seeded from the KILLSWITCH env on cold start, then
// kept in sync with the persisted `settings.serving` flag so a toggle from the
// admin dashboard propagates across isolates. syncServing() refreshes at most
// once per 15s to keep the /v1/ads hot path cheap.
let serving = !config.killswitch;
let servingSyncedAt = 0;
async function syncServing() {
  if (Date.now() - servingSyncedAt < 15000) return;
  servingSyncedAt = Date.now();
  try {
    const v = await repo.getSetting("serving");
    if (typeof v === "boolean") serving = v;
  } catch { /* settings table absent / unreachable — keep current value */ }
}
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
// Validate + normalize an affiliate application's socials. At least one handle is
// required, and every handle provided must carry a non-negative follower count.
function parseAffiliateSocials(body: any): { socials?: any; error?: string } {
  const b = body || {};
  const handle = (v: any) => {
    const s = String(v ?? "").trim().replace(/^@+/, "").slice(0, 60);
    return s || null;
  };
  const platforms: [string, string, string][] = [
    ["instagram", "instagramFollowers", "Instagram"],
    ["linkedin", "linkedinFollowers", "LinkedIn"],
    ["twitter", "twitterFollowers", "Twitter"],
  ];
  const socials: any = {};
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

// ── health & catalog ──
route("GET", "/healthz", async () => json(200, { ok: true }));
route("GET", "/v1/config", async () => { await syncServing(); return json(200, { serving, revenueShare: config.revenueShare }); });

// Advertiser pricing for the lander (min / suggested / top). Kept off /v1/config
// so the extension's frequent config polls stay query-free. top = max(anchor,
// highest active bid).
route("GET", "/v1/pricing", async () => {
  const pricing = await repo.getPricing();
  const topBidCents = Math.max(pricing.topBidAnchorCents, await repo.topActiveBidCents());
  return json(200, { minBidCents: pricing.minBidCents, suggestedBidCents: pricing.suggestedBidCents, topBidCents });
});
route("GET", "/v1/ads", async () => {
  await syncServing();
  const ads = serving ? await repo.activeAds() : [];
  return json(200, { revenueShare: config.revenueShare, ads: ads.map((a: any) => ({ id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined })) });
});
route("GET", "/v1/leaderboard", async () => {
  const rows = await repo.leaderboard();
  return json(200, { leaderboard: rows.map((r: any, i: number) => ({ rank: i + 1, brand: r.brand, line: r.ad_line })) });
});

// ── devices & events ──
route("POST", "/v1/devices/register", async () => json(200, await repo.registerDevice()));
// Self-serve device→account link: the extension's freeai.fyi bridge posts the
// device creds + the site's web session; we attach the device to that user and
// enroll them as an affiliate so the popup's crew lights up. No magic link.
route("POST", "/v1/devices/link", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  await repo.linkDeviceToUser(device.id, user.id);
  await repo.getOrCreateAffiliate(user.id);
  return json(200, { ok: true });
});
route("POST", "/v1/events", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const body = ctx.body || {};
  if (!body.batchKey || !Array.isArray(body.events)) return json(400, { error: "batchKey and events[] required" });
  try {
    const result = await repo.ingestBatch({
      deviceId: device.id, batchKey: body.batchKey, events: body.events,
      // Which product reported this batch (chrome / claude_code / desktop), so a
      // credit can be attributed back to its surface; ignored unless allow-listed.
      source: ["chrome", "claude_code", "desktop"].includes(body.source) ? body.source : null,
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
  const { minBidCents } = await repo.getPricing();
  if (!(priceCents >= minBidCents)) return json(400, { error: `min bid is $${(minBidCents / 100).toFixed(2)} per block` });
  if (!(nBlocks >= 1)) return json(400, { error: "at least 1 block" });
  const campaignId = await repo.createPendingCampaign({ email, brand, adLine, url, category, color: normalizeHexColor(color), pricePerBlockCents: priceCents, blocks: nBlocks, showOnLeaderboard });
  const session = await stripe.createCheckoutSession({
    mode: "payment", customer_email: email,
    // receipt_email isn't a Checkout Session param; it lives on the PaymentIntent.
    payment_intent_data: { receipt_email: email },
    line_items: [{ quantity: nBlocks, price_data: { currency: "usd", unit_amount: priceCents, product_data: { name: "FreeAI spinner block — 1,000 impressions", description: `${brand ? brand + " — " : ""}"${adLine}" → ${url}`, images: ["https://freeai.fyi/og.png"] } } }],
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
  const token = await repo.createEmailToken(ctx.body.email, device.id, config.emailTokenTtlMs, null, config.emailCooldownMs);
  if (token) await mailer.sendVerifyEmail(ctx.body.email, `${config.apiBaseUrl}/v1/auth/verify?token=${token}`);
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

// Device-scoped affiliate "crew": the extension popup's earn-with-friends panel.
// Anonymous until the device is linked to a user (via the magic link from
// /v1/auth/request-link). Once linked, the user is auto-enrolled as an approved
// affiliate and this returns their invite code/link plus the per-friend breakdown
// — no web session needed, just device credentials.
route("GET", "/v1/me/affiliate", async (ctx: any) => {
  const device = await authDeviceFrom(ctx, true);
  if (!device) return json(401, { error: "bad device credentials" });
  const rewardPct = config.affiliateRewardBps / 100;
  const user = await repo.userForDevice(device.id);
  if (!user) return json(200, { linked: false, rewardPct });
  const aff = await repo.getOrCreateAffiliate(user.id);
  const crew = await repo.affiliateCrew(aff.id, user.id);
  // Pending invites you've sent that haven't joined yet — surfaced so the popup's
  // crew slots stay filled across reopens. Drop any whose masked address already
  // matches a joined friend (an invited friend who accepted shows up in `friends`).
  const friendNames = new Set(crew.friends.map((f: any) => f.name));
  const invited = (await repo.pendingInvitesForUser(user.id)).filter((i: any) => !friendNames.has(i.email));
  return json(200, {
    linked: true,
    email: user.email,
    code: aff.code,
    link: `${config.siteUrl}/redeem.html?ref=${aff.code}`,
    rewardPct,
    crewSize: CREW_SIZE,
    attributedCount: crew.count,
    creditedUsd: crew.creditedMillicents / 100000,
    friends: crew.friends,
    invited,
  });
});

// Invite a friend to your crew from the extension popup. Device-scoped (no web
// session): authed by device credentials, the invite carries the user's affiliate
// link so the friend is attributed to them — earning the affiliate's cut forever.
route("POST", "/v1/me/affiliate/invite", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const user = await repo.userForDevice(device.id);
  if (!user) return json(401, { error: "link this device to invite friends" });
  const email = String(ctx.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
    return json(400, { error: "you can't invite your own email" });
  }
  const aff = await repo.getOrCreateAffiliate(user.id);
  const link = `${config.siteUrl}/redeem.html?ref=${aff.code}`;
  const invite = await repo.createReferralInvite(user.id, email, aff.code);
  await mailer.sendCrewInviteEmail(email, { inviterEmail: user.email, link, rewardPct: config.affiliateRewardBps / 100 });
  return json(200, { ok: true, sent: true, invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at } });
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
  const token = await repo.createEmailToken(body.email, null, config.emailTokenTtlMs, body.referralCode, config.emailCooldownMs);
  if (token) await mailer.sendWebLoginEmail(body.email, `${config.apiBaseUrl}/v1/web/session?token=${token}`);
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
  const [hasSurvey, referred] = await Promise.all([
    repo.hasOnboardingSurvey(user.id),
    repo.hasReferredAnyone(user.id),
  ]);
  return json(200, {
    email: user.email, balanceUsd: bal.balanceMillicents / 100000,
    needsSurvey: !hasSurvey, needsReferral: !referred,
  });
});
// Sign out: revoke the session server-side so the bearer token is dead even if
// it lingers in a browser/localStorage. Always 200 (idempotent).
route("POST", "/v1/web/logout", async (ctx: any) => {
  await repo.deleteWebSession(sessionFrom(ctx));
  return json(200, { ok: true });
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
// Per-service activation for the Install tab: true once the account has received
// its first credit from that surface (chrome / claude_code / desktop).
route("GET", "/v1/web/sources", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const sources = await repo.sourcesForUser(user.id);
  return json(200, { sources });
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
route("GET", "/v1/web/waitlist", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const surfaces = await repo.listWaitlistSurfaces();
  const joined = new Set((await repo.waitlistsForUser(user.id)).map((w: any) => w.surface));
  return json(200, {
    surfaces: surfaces.map((s: any) => ({ surface: s.surface, label: s.label, joined: joined.has(s.surface) })),
  });
});
route("POST", "/v1/web/waitlist", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const surface = ctx.body?.surface;
  const known = await repo.listWaitlistSurfaces();
  if (!surface || !known.some((s: any) => s.surface === surface)) {
    return json(400, { error: "unknown surface", surfaces: known.map((s: any) => s.surface) });
  }
  const created = await repo.joinWaitlist(user.id, surface);
  return json(200, { ok: true, surface, joined: true, alreadyJoined: !created });
});
route("POST", "/v1/web/referrals/invite", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const email = String(ctx.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
    return json(400, { error: "You can't refer your own email" });
  }
  const code = await repo.getOrCreateReferralCode(user.id);
  const link = `${config.siteUrl}/redeem.html?ref=${code}`;
  const invite = await repo.createReferralInvite(user.id, email, code);
  // The invite row above is the onboarding gate and the source of truth: a
  // friend never has to act for the inviter to progress. Delivering the email
  // is best-effort — if the mail provider rejects it (e.g. an unverified
  // sending domain), record it for the admin diag but don't fail the request,
  // or the user is stranded on onboarding behind an "internal error" for an
  // invite that was actually saved.
  let sent = true;
  try {
    await mailer.sendReferralInviteEmail(email, { inviterEmail: user.email, link, rewardUsd: config.referralRewardCents / 100 });
  } catch (err: any) {
    sent = false;
    console.error("[freeai] referral invite email failed:", err?.message);
    try {
      await pool.query(
        "insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)",
        ["POST", "/v1/web/referrals/invite", String(err?.message || err), String(err?.stack || "")]
      );
    } catch (_e) { /* logging is best-effort too */ }
  }
  return json(200, { ok: true, sent, invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at } });
});
// ── affiliate program ──
route("GET", "/v1/web/affiliate", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  // Self-serve: everyone is an affiliate. Ensure enrollment, then read details.
  await repo.getOrCreateAffiliate(user.id);
  const data = await repo.affiliateForUser(user.id);
  const app = data.application;
  // Influencer upgrade = a higher rate or a raised cap above the base config.
  const upgraded = app.rewardBps > config.affiliateRewardBps || app.capMillicents > config.affiliateCapCents * 1000;
  // Upgrade requested = the user attached socials (auto-enrolled rows have none).
  const upgradeRequested = !!(app.socials.instagram || app.socials.linkedin || app.socials.twitter);
  return json(200, {
    enrolled: true,
    code: app.code,
    link: app.code ? `${config.siteUrl}/redeem.html?ref=${app.code}` : null,
    socials: app.socials,
    rewardPct: app.rewardBps / 100,
    capUsd: app.capMillicents / 100000,
    creditedUsd: app.creditedMillicents / 100000,
    attributedCount: app.attributedCount,
    upgraded, upgradeRequested,
    attributed: data.attributed,
    hasReferrer: data.hasReferrer,
    canApplyCode: !data.attributed && !data.hasReferrer,
  });
});
// Influencer upgrade application: attach socials to request a custom rate /
// uncapped earnings. Keeps the user's active base 10% — no status downgrade.
route("POST", "/v1/web/affiliate/apply", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const parsed = parseAffiliateSocials(ctx.body);
  if (parsed.error) return json(400, { error: parsed.error });
  await repo.requestAffiliateUpgrade(user.id, parsed.socials);
  return json(200, { ok: true });
});
route("POST", "/v1/web/affiliate-code", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const code = String(ctx.body?.code || "").trim();
  if (!code) return json(400, { error: "code required" });
  const result = await repo.applyAffiliateCodeForUser(user.id, code);
  if (result.ok) return json(200, { ok: true });
  const msg = ({
    already_affiliated: "your account already has an affiliate code",
    has_referrer: "your account was referred, so an affiliate code can't be added",
    invalid_code: "that affiliate code isn't valid",
  } as any)[result.reason] || "couldn't apply that code";
  return json(400, { error: msg, reason: result.reason });
});
// First-login onboarding survey: which AI models the user uses and where, both
// multi-select. Saved before the refer-a-friend step; clears the needsSurvey gate.
route("POST", "/v1/web/onboarding/survey", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const MODELS = ["claude", "chatgpt", "gemini", "other"];
  const SURFACES = ["browser_chrome", "browser_other", "desktop_app", "cursor", "terminal", "other"];
  const body = ctx.body || {};
  const models = [...new Set((Array.isArray(body.models) ? body.models : []).filter((m: any) => MODELS.includes(m)))];
  const surfaces = [...new Set((Array.isArray(body.surfaces) ? body.surfaces : []).filter((s: any) => SURFACES.includes(s)))];
  if (!models.length || !surfaces.length) return json(400, { error: "select at least one model and one surface" });
  const surfaceOther = surfaces.includes("other") ? (String(body.surfaceOther || "").trim().slice(0, 200) || null) : null;
  await repo.saveOnboardingSurvey(user.id, { models, surfaces, surfaceOther });
  return json(200, { ok: true });
});
route("POST", "/v1/web/redemptions", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const body = ctx.body || {};
  const plan = GIFT_PLANS[body.plan];
  const months = parseInt(body.months, 10);
  const amountCents = plan ? giftPriceCents(plan.id, months) : null;
  if (!amountCents) return json(400, { error: "plan must be pro/max5x/max20x and months 1/3/6/12" });
  // Gift cards go only to the account's own email — never a request-supplied
  // address — so a stolen session can't redirect a cash-out to an attacker inbox.
  const recipientEmail = user.email;
  if (!recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) return json(400, { error: "your account needs a verified email to redeem" });
  const balance = await repo.balanceForUser(user.id);
  if (balance.balanceMillicents < amountCents * 1000) return json(403, { error: "insufficient credits", balanceUsd: balance.balanceMillicents / 100000, requiredUsd: amountCents / 100 });
  const redemptionId = crypto.randomUUID();
  await mailer.sendGiftRedemptionEmail(config.giftFulfillmentEmail, { redemptionId, planName: plan.name, months, amountUsd: amountCents / 100, recipientEmail });
  const recorded = await repo.recordGiftRedemptionForUser({
    id: redemptionId, userId: user.id, plan: plan.id, months, amountCents, recipientEmail,
    referralRewardMillicents: config.referralRewardCents * 1000, referralCap: config.referralCap,
  });
  if (!recorded) return json(409, { error: "insufficient credits" });
  // User-facing emails are best-effort — a mail hiccup must never fail a
  // redemption that's already committed to the ledger.
  try {
    await mailer.sendRedemptionConfirmationEmail(recipientEmail, { planName: plan.name, months, amountUsd: amountCents / 100 });
  } catch (err: any) { console.error("[freeai] redemption confirmation email failed:", err?.message); }
  if (recorded.reward?.referrerEmail) {
    try {
      await mailer.sendReferralRewardEmail(recorded.reward.referrerEmail, { rewardUsd: recorded.reward.rewardMillicents / 100000, link: `${config.siteUrl}/redeem.html` });
    } catch (err: any) { console.error("[freeai] referral reward email failed:", err?.message); }
  }
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
  const result = await repo.approveCampaign(ctx.body?.campaignId);
  if (!result) return json(404, { ok: false });
  // Tell the advertiser their ad is live. Wrapped so a mail failure never
  // fails the approval (already committed above).
  try {
    await mailer.sendCampaignLiveEmail((result as any).email, {
      campaignId: ctx.body?.campaignId,
      brand: (result as any).brand,
      adLine: (result as any).adLine,
      blocks: (result as any).blocks,
    });
  } catch (err: any) {
    console.error("[freeai] live email failed:", err.message);
  }
  return json(200, { ok: true });
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
// ── affiliate review ──
route("GET", "/v1/admin/affiliates", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { affiliates: await repo.listAffiliateApplications() });
});
route("POST", "/v1/admin/affiliates/approve", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.approveAffiliate(ctx.body?.affiliateId);
  return json(result ? 200 : 404, result ? { ok: true, code: result.code } : { ok: false });
});
route("POST", "/v1/admin/affiliates/reject", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.rejectAffiliate(ctx.body?.affiliateId, ctx.body?.note);
  return json(result ? 200 : 404, { ok: !!result });
});
route("POST", "/v1/admin/affiliates/grant", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const b = ctx.body || {};
  const rewardBps = Number(b.rewardBps);
  const capMillicents = Number(b.capMillicents);
  if (!Number.isInteger(rewardBps) || rewardBps < 1 || rewardBps > 10000) return json(400, { error: "rewardBps must be 1–10000 (0.01%–100%)" });
  if (!Number.isInteger(capMillicents) || capMillicents < 0) return json(400, { error: "capMillicents must be a whole number ≥ 0" });
  const result = await repo.grantAffiliateUpgrade(b.affiliateId, { rewardBps, capMillicents, code: b.code });
  return json(result.ok ? 200 : (result.error === "not found" ? 404 : 400), result);
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
  serving = ctx.body.serving;
  servingSyncedAt = Date.now();
  try { await repo.setSetting("serving", serving); } // persist across isolates
  catch (err: any) { console.error("[freeai] killswitch persist failed:", err?.message); }
  return json(200, { ok: true, serving });
});
route("POST", "/v1/admin/payouts", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, await runPayouts());
});

// ── advertiser pricing (min / suggested / top-bid anchor) ──
route("GET", "/v1/admin/pricing", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const pricing = await repo.getPricing();
  return json(200, { ...pricing, topActiveBidCents: await repo.topActiveBidCents() });
});
route("POST", "/v1/admin/pricing", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const cur = await repo.getPricing();
  const b = ctx.body || {};
  const pick = (n: any, d: number) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : d);
  const next = {
    minBidCents: Math.max(50, pick(b.minBidCents, cur.minBidCents)),
    suggestedBidCents: pick(b.suggestedBidCents, cur.suggestedBidCents),
    topBidAnchorCents: Math.max(0, pick(b.topBidAnchorCents, cur.topBidAnchorCents)),
  };
  next.suggestedBidCents = Math.max(next.minBidCents, next.suggestedBidCents); // suggested ≥ min
  await repo.setPricing(next);
  return json(200, next);
});

// ── admin dashboard (read + management) ──
// Money helpers: ledger is millicents, gift_redemptions is cents.
const mcUsd = (v: any) => Number(v || 0) / 100000;
const cUsd = (v: any) => Number(v || 0) / 100;

route("GET", "/v1/admin/overview", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const o = await repo.adminOverview();
  const m = o.money;
  return json(200, {
    revenue: {
      adsPurchasedUsd: mcUsd(m.campaign_credit),
      refundedUsd: -mcUsd(m.campaign_refund),
      platformFeeUsd: mcUsd(m.platform_fee),
      developerCreditUsd: mcUsd(m.dev_credit),
      referralCreditUsd: mcUsd(m.referral_credit),
      affiliateCreditUsd: mcUsd(m.affiliate_credit),
      paidOutUsd: -mcUsd(m.payout_debit),
      redeemedUsd: -mcUsd(m.redemption_debit),
      adminAdjustUsd: mcUsd(m.admin_adjust),
      outstandingLiabilityUsd: mcUsd(m.liability),
    },
    counts: o.counts,
    campaignsByStatus: o.campaignsByStatus,
    pendingRedemptionsUsd: cUsd(o.counts.redemptions_pending_cents),
    serving,
  });
});

route("GET", "/v1/admin/metrics/daily", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const days = parseInt(ctx.query.get("days") || "30", 10);
  const raw = await repo.adminDailyMetrics(days);
  const key = (d: any) => new Date(d).toISOString().slice(0, 10);
  const map = new Map<string, any>();
  const ensure = (k: string) => {
    if (!map.has(k)) map.set(k, { date: k, impressions: 0, clicks: 0, adsPurchasedUsd: 0, platformFeeUsd: 0, developerCreditUsd: 0, recognizedUsd: 0, effectiveCpmUsd: 0, newUsers: 0, newDevices: 0, redemptions: 0, redemptionsUsd: 0 });
    return map.get(k);
  };
  for (const r of raw.events) { const o = ensure(key(r.d)); o.impressions = Number(r.imp); o.clicks = Number(r.clk); }
  for (const r of raw.ledger) { const o = ensure(key(r.d)); o.adsPurchasedUsd = mcUsd(r.bought); o.platformFeeUsd = mcUsd(r.fee); o.developerCreditUsd = mcUsd(r.dev); o.recognizedUsd = mcUsd(r.dev) + mcUsd(r.fee); }
  for (const r of raw.users) { ensure(key(r.d)).newUsers = Number(r.n); }
  for (const r of raw.devices) { ensure(key(r.d)).newDevices = Number(r.n); }
  for (const r of raw.redemptions) { const o = ensure(key(r.d)); o.redemptions = Number(r.n); o.redemptionsUsd = cUsd(r.cents); }
  // Fill the full window so every day shows, even with no activity.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const series: any[] = [];
  for (let i = raw.days - 1; i >= 0; i--) {
    const dt = new Date(today); dt.setUTCDate(dt.getUTCDate() - i);
    const o = ensure(dt.toISOString().slice(0, 10));
    o.effectiveCpmUsd = o.impressions > 0 ? (o.recognizedUsd / o.impressions) * 1000 : 0;
    series.push(o);
  }
  return json(200, { days: raw.days, series });
});

route("GET", "/v1/admin/campaigns/all", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminCampaigns({
    status: ctx.query.get("status") || null,
    limit: ctx.query.get("limit"), offset: ctx.query.get("offset"),
  });
  return json(200, { campaigns: rows.map((c: any) => ({
    id: c.id, brand: c.brand, adLine: c.ad_line, url: c.url, category: c.category, status: c.status,
    bidUsd: c.price_per_block_cents / 100, blocks: c.blocks,
    impressionsTotal: c.impressions_total, impressionsRemaining: c.impressions_remaining, impressionsServed: c.impressions_served,
    showOnLeaderboard: c.show_on_leaderboard, reviewNote: c.review_note,
    recognizedUsd: mcUsd(c.recognized_millicents), advertiserEmail: c.advertiser_email,
    createdAt: c.created_at, paidAt: c.paid_at, activatedAt: c.activated_at,
  })) });
});
route("POST", "/v1/admin/campaigns/cancel", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const ok = await repo.cancelCampaign(ctx.body?.campaignId);
  return json(ok ? 200 : 404, { ok });
});

route("GET", "/v1/admin/redemptions", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminRedemptions({ status: ctx.query.get("status") || null, limit: ctx.query.get("limit") });
  return json(200, { redemptions: rows.map((r: any) => ({
    id: r.id, plan: GIFT_PLANS[r.plan]?.name || r.plan, planId: r.plan, months: r.months,
    amountUsd: r.amount_cents / 100, recipientEmail: r.recipient_email, userEmail: r.user_email,
    status: r.status, createdAt: r.created_at,
  })) });
});
route("POST", "/v1/admin/redemptions/status", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.setRedemptionStatus(ctx.body?.id, ctx.body?.status, !!ctx.body?.refund);
  if (!result) return json(400, { ok: false, error: "invalid id or status" });
  return json(200, { ok: true, status: result.status, refunded: result.refunded });
});

route("GET", "/v1/admin/users", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminUsers({ search: ctx.query.get("search") || null, limit: ctx.query.get("limit"), offset: ctx.query.get("offset") });
  return json(200, { users: rows.map((u: any) => ({
    id: u.id, email: u.email, emailVerified: u.email_verified, payoutsEnabled: u.payouts_enabled,
    stripeLinked: !!u.stripe_account_id, referralCode: u.referral_code, referredBy: u.referred_by,
    devices: u.devices, balanceUsd: mcUsd(u.balance_millicents), earnedUsd: mcUsd(u.earned_millicents), createdAt: u.created_at,
  })) });
});

route("GET", "/v1/admin/emails", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminEmails();
  if ((ctx.query.get("format") || "") === "csv") {
    const esc = (s: any) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const body = ["email,source,created_at", ...rows.map((r: any) => [esc(r.email), esc(r.source), esc(r.created_at)].join(","))].join("\n");
    return new Response(body, { status: 200, headers: { ...CORS, "Access-Control-Allow-Origin": resolveOrigin(ctx.req), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="freeai-emails.csv"' } });
  }
  return json(200, { emails: rows });
});

route("GET", "/v1/admin/income", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminIncome();
  return json(200, { byType: rows.map((r: any) => ({ entryType: r.entry_type, count: r.n, totalUsd: mcUsd(r.total) })) });
});

route("GET", "/v1/admin/payouts", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const list = await repo.adminPayoutsList();
  const payable = await repo.payableUsers(config.payoutThresholdCents * 1000);
  return json(200, {
    payouts: list.map((p: any) => ({ id: p.id, email: p.email, userId: p.user_id, amountUsd: p.amount_cents / 100, status: p.status, transferId: p.stripe_transfer_id, createdAt: p.created_at })),
    payable: { count: payable.length, totalUsd: payable.reduce((s: number, u: any) => s + u.balance / 100000, 0), thresholdUsd: config.payoutThresholdCents / 100 },
  });
});

route("GET", "/v1/admin/referrals", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const r = await repo.adminReferrals();
  return json(200, {
    byStatus: r.byStatus.map((s: any) => ({ status: s.status, count: s.n, rewardUsd: mcUsd(s.reward) })),
    top: r.top.map((t: any) => ({ email: t.email, userId: t.referrer_user_id, referred: t.referred, rewarded: t.rewarded, rewardUsd: mcUsd(t.reward_millicents) })),
  });
});

route("GET", "/v1/admin/devices", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const d = await repo.adminDevices(config.dailyImpressionCap, config.dailyClickCap);
  return json(200, {
    totals: d.totals,
    caps: { dailyImpressionCap: config.dailyImpressionCap, dailyClickCap: config.dailyClickCap },
    heavyDevices: d.heavyDevices.map((x: any) => ({ deviceId: x.device_id, impressions: Number(x.imp), clicks: Number(x.clk) })),
    heavyIps: d.heavyIps.map((x: any) => ({ ipHash: x.ip_hash, devices: x.devices, impressions: Number(x.imp) })),
  });
});

route("GET", "/v1/admin/schema", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { tables: await repo.adminSchema() });
});

route("POST", "/v1/admin/ledger/adjust", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const id = await repo.adminLedgerAdjust({
    userId: ctx.body?.userId || null, deviceId: ctx.body?.deviceId || null,
    amountCents: ctx.body?.amountCents, direction: ctx.body?.direction, note: ctx.body?.note,
  });
  if (!id) return json(400, { ok: false, error: "need userId or deviceId, a non-zero amountCents, and direction credit|debit" });
  return json(200, { ok: true, ledgerId: id });
});

route("GET", "/v1/admin/invites", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const d = await repo.adminInvites();
  return json(200, {
    byStatus: d.byStatus.map((s: any) => ({ status: s.status, count: s.n })),
    invites: d.recent.map((r: any) => ({
      email: r.email, status: r.status, code: r.code, referrerEmail: r.referrer_email,
      createdAt: r.created_at, sentAt: r.sent_at, joinedAt: r.joined_at, rewardedAt: r.rewarded_at,
    })),
  });
});

// Read-only view of the economic knobs that drive the marketplace + gift catalog.
route("GET", "/v1/admin/config", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, {
    revenueSharePct: config.revenueShare * 100,
    grossCpmUsd: config.grossCpmCents / 100,
    dailyImpressionCap: config.dailyImpressionCap,
    ipDailyImpressionCap: config.ipDailyImpressionCap,
    dailyClickCap: config.dailyClickCap,
    payoutThresholdUsd: config.payoutThresholdCents / 100,
    referralRewardUsd: config.referralRewardCents / 100,
    referralCap: config.referralCap,
    affiliateRewardPct: config.affiliateRewardBps / 100,
    affiliateCapUsd: config.affiliateCapCents / 100,
    giftFulfillmentEmail: config.giftFulfillmentEmail,
    giftPlans: Object.values(GIFT_PLANS).map((p: any) => ({ id: p.id, name: p.name, monthlyUsd: p.monthlyCents / 100 })),
    serving,
  });
});

route("GET", "/v1/admin/waitlist", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const d = await repo.adminWaitlist();
  return json(200, {
    bySurface: d.bySurface.map((s: any) => ({ surface: s.surface, label: s.label, count: s.n })),
    signups: d.recent.map((r: any) => ({ surface: r.surface, email: r.email, createdAt: r.created_at })),
  });
});

route("GET", "/v1/admin/errors", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminErrors();
  return json(200, { errors: rows.map((r: any) => ({ id: String(r.id), method: r.method, path: r.path, message: r.message, createdAt: r.created_at })) });
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
    // Best-effort: persist the failure for the admin dashboard. Never let
    // logging break the error response.
    try { await pool.query("insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)", [req.method, path, String(err?.message || err), String(err?.stack || "")]); } catch (_e) { /* ignore */ }
    return withCors(json(500, { error: "internal error" }));
  } finally {
    console.log(`[freeai] ${req.method} ${path} ${Date.now() - started}ms`);
  }
});
