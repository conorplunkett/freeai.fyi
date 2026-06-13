// Wires real dependencies from environment config.

const { createRepo } = require("./repo");
const { createStripe } = require("./stripe");
const { createMailer } = require("./mailer");
const { createRateLimiter } = require("./ratelimit");

function loadConfig(env = process.env) {
  const siteUrl = env.SITE_URL || "https://freeai.fyi";
  return {
    port: parseInt(env.PORT || "8787", 10),
    databaseUrl: env.DATABASE_URL,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    siteUrl,
    apiBaseUrl: env.API_BASE_URL || `http://localhost:${env.PORT || 8787}`,
    corsOrigin: env.CORS_ORIGIN || siteUrl,
    adminKey: env.ADMIN_KEY,
    killswitch: env.KILLSWITCH === "1", // start with ad serving disabled

    revenueShare: parseFloat(env.REVENUE_SHARE || "0.5"), // user's cut, paid out as Claude credits
    grossCpmCents: parseInt(env.GROSS_CPM_CENTS || "1200", 10),
    dailyImpressionCap: parseInt(env.DAILY_IMPRESSION_CAP || "5000", 10),
    payoutThresholdCents: parseInt(env.PAYOUT_THRESHOLD_CENTS || "1000", 10), // $10
    giftFulfillmentEmail: env.GIFT_FULFILLMENT_EMAIL || "conor.p43@gmail.com", // manual gift card fulfillment inbox
    emailTokenTtlMs: parseInt(env.EMAIL_TOKEN_TTL_MS || "1800000", 10), // 30 min
    webSessionTtlMs: parseInt(env.WEB_SESSION_TTL_MS || "2592000000", 10), // 30 days
    clickTokenTtlMs: parseInt(env.CLICK_TOKEN_TTL_MS || "120000", 10), // 2 min
    maxBodyBytes: parseInt(env.MAX_BODY_BYTES || "65536", 10), // 64 KB
    // OAuth
    googleClientId: env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    appleClientId: env.APPLE_CLIENT_ID || "",
    appleTeamId: env.APPLE_TEAM_ID || "",
    appleKeyId: env.APPLE_KEY_ID || "",
    applePrivateKey: (env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    // mail
    mailProvider: env.MAIL_PROVIDER || "console",
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
    // rate limit
    rateLimitCapacity: parseInt(env.RATE_LIMIT_CAPACITY || "120", 10),
    rateLimitRefillPerSec: parseFloat(env.RATE_LIMIT_REFILL_PER_SEC || "5"),
  };
}

// Postgres pool options. Managed providers (Supabase, Neon, …) require TLS;
// turn it on for them automatically while leaving local/plaintext dev untouched.
// Set DATABASE_SSL=1 to force TLS for any other managed host (RDS, etc.).
function pgPoolConfig(env = process.env) {
  const connectionString = env.DATABASE_URL || "";
  const needsSsl =
    env.DATABASE_SSL === "1" ||
    /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString) ||
    /\.supabase\.(co|com)\b/.test(connectionString) ||
    /\.neon\.tech\b/.test(connectionString);
  return { connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : undefined };
}

async function boot(env = process.env) {
  const config = loadConfig(env);
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (!config.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY is required");

  const { Pool } = require("pg");
  const pool = new Pool(pgPoolConfig(env));
  const repo = createRepo(pool);
  const stripe = createStripe(config.stripeSecretKey);
  const mailer = createMailer(config);
  const rateLimiter = createRateLimiter({
    capacity: config.rateLimitCapacity,
    refillPerSec: config.rateLimitRefillPerSec,
  });
  return { deps: { repo, stripe, mailer, rateLimiter, config }, pool };
}

module.exports = { boot, loadConfig, pgPoolConfig };
