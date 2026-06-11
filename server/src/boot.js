// Wires real dependencies from environment config.

const { createRepo } = require("./repo");
const { createStripe } = require("./stripe");

function loadConfig(env = process.env) {
  return {
    port: parseInt(env.PORT || "8787", 10),
    databaseUrl: env.DATABASE_URL,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    siteUrl: env.SITE_URL || "https://betterbacks.ai",
    adminKey: env.ADMIN_KEY,
    revenueShare: parseFloat(env.REVENUE_SHARE || "0.9"), // the better split
    grossCpmCents: parseInt(env.GROSS_CPM_CENTS || "1200", 10),
    dailyImpressionCap: parseInt(env.DAILY_IMPRESSION_CAP || "5000", 10),
    payoutThresholdCents: parseInt(env.PAYOUT_THRESHOLD_CENTS || "1000", 10), // $10
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
  return { deps: { repo, stripe, config }, pool };
}

module.exports = { boot, loadConfig };
