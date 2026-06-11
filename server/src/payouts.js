// Weekly payout sweep: every user with payouts enabled and a ledger balance at
// or above the threshold gets a Stripe Connect transfer for their whole-cent
// balance. Run via POST /v1/admin/payouts or `npm run payouts` (cron it).

const crypto = require("node:crypto");

async function runPayouts({ repo, stripe, config }) {
  const users = await repo.payableUsers(config.payoutThresholdCents * 1000);
  const results = [];
  for (const user of users) {
    const amountCents = Math.floor(user.balance / 1000); // pay whole cents only
    if (amountCents < config.payoutThresholdCents) continue;
    try {
      const transfer = await stripe.createTransfer({
        amount: amountCents,
        currency: "usd",
        destination: user.stripe_account_id,
        transfer_group: `payout_${user.id}_${crypto.randomUUID()}`,
      });
      await repo.recordPayout(user.id, amountCents, transfer.id);
      results.push({ userId: user.id, amountCents, transferId: transfer.id, ok: true });
    } catch (err) {
      results.push({ userId: user.id, amountCents, ok: false, error: err.message });
    }
  }
  return { paid: results.filter((r) => r.ok).length, results };
}

module.exports = { runPayouts };
