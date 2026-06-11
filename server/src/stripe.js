// Minimal Stripe REST client — zero dependencies.
// Stripe's API is plain HTTPS + form-encoded bodies, so we talk to it directly
// with global fetch. The fetch implementation is injectable so tests can fake
// the transport without touching the network.
//
// Endpoints used (all under https://api.stripe.com/v1):
//   POST /checkout/sessions   money IN  — advertiser pays for blocks
//   POST /accounts            money OUT — create Connect Express account
//   POST /account_links       money OUT — hosted onboarding (KYC, bank, tax)
//   POST /transfers           money OUT — move a developer's balance to them

const crypto = require("node:crypto");

const API_BASE = "https://api.stripe.com/v1";

// Stripe expects nested params in bracket notation:
// { line_items: [{ price_data: { currency: "usd" } }] }
//   -> line_items[0][price_data][currency]=usd
function formEncode(obj, prefix = "", out = []) {
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === "object") formEncode(item, `${name}[${i}]`, out);
        else out.push(`${name}[${i}]=${encodeURIComponent(item)}`);
      });
    } else if (typeof val === "object") {
      formEncode(val, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(val)}`);
    }
  }
  return out.join("&");
}

class StripeError extends Error {
  constructor(status, body) {
    super(`Stripe ${status}: ${body?.error?.message || JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

function createStripe(secretKey, { fetchImpl = fetch } = {}) {
  async function request(method, path, params) {
    const res = await fetchImpl(API_BASE + path, {
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
    // --- money in: advertiser checkout ---
    createCheckoutSession: (params) => request("POST", "/checkout/sessions", params),

    // --- refund a rejected campaign ---
    createRefund: (params) => request("POST", "/refunds", params),

    // --- money out: developer payouts via Connect Express ---
    createAccount: (params) => request("POST", "/accounts", params),
    createAccountLink: (params) => request("POST", "/account_links", params),
    createTransfer: (params, idempotencyKey) =>
      request("POST", "/transfers", { ...params, ...(idempotencyKey ? {} : {}) }),

    request,
  };
}

// Verify a Stripe webhook signature.
// Header format: "t=<unix>,v1=<hmac>,v1=<hmac>..." where each v1 is
// HMAC-SHA256(`${t}.${rawBody}`, webhookSecret) hex-encoded.
function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
  if (!signatureHeader) return false;
  const parts = Object.create(null);
  const v1s = [];
  for (const piece of signatureHeader.split(",")) {
    const [k, v] = piece.split("=", 2);
    if (k === "v1") v1s.push(v);
    else parts[k.trim()] = v;
  }
  const t = parseInt(parts.t, 10);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return v1s.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  });
}

// Helper for tests / local signing.
function signWebhookPayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

module.exports = { createStripe, verifyWebhookSignature, signWebhookPayload, formEncode, StripeError };
