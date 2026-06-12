// Wires real dependencies from environment config.

const { createRepo } = require("./repo");
const { createStripe } = require("./stripe");
const { createMailer } = require("./mailer");
const { createRateLimiter } = require("./ratelimit");

function loadConfig(env = process.env) {
  const siteUrl = env.SITE_URL || "https://betterbacks.ai";
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

    revenueShare: parseFloat(env.REVENUE_SHARE || "0.9"), // the better split
    grossCpmCents: parseInt(env.GROSS_CPM_CENTS || "1200", 10),
    dailyImpressionCap: parseInt(env.DAILY_IMPRESSION_CAP || "5000", 10),
    payoutThresholdCents: parseInt(env.PAYOUT_THRESHOLD_CENTS || "1000", 10), // $10
    emailTokenTtlMs: parseInt(env.EMAIL_TOKEN_TTL_MS || "1800000", 10), // 30 min
    clickTokenTtlMs: parseInt(env.CLICK_TOKEN_TTL_MS || "120000", 10), // 2 min
    maxBodyBytes: parseInt(env.MAX_BODY_BYTES || "65536", 10), // 64 KB
    // mail
    mailProvider: env.MAIL_PROVIDER || "console",
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
    // rate limit
    rateLimitCapacity: parseInt(env.RATE_LIMIT_CAPACITY || "120", 10),
    rateLimitRefillPerSec: parseFloat(env.RATE_LIMIT_REFILL_PER_SEC || "5"),
  };
}

async function boot(env = process.env) {
  const config = loadConfig(env);
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (!config.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY is required");

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: config.databaseUrl });
  const repo = createRepo(pool);
  const stripe = createStripe(config.stripeSecretKey);
  const mailer = createMailer(config);
  const rateLimiter = createRateLimiter({
    capacity: config.rateLimitCapacity,
    refillPerSec: config.rateLimitRefillPerSec,
  });
  return { deps: { repo, stripe, mailer, rateLimiter, config }, pool };
}

module.exports = { boot, loadConfig };
