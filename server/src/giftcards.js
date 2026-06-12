// Claude gift card redemption catalog. Prices are in USD cents and follow the
// published schedule exactly (monthly base price × months, no discounts).
// Fulfillment is manual for now: a redemption emails the fulfillment inbox and
// the gift card arrives in the user's email within 48 hours.

const GIFT_PLANS = {
  pro: { id: "pro", name: "Claude Pro", tagline: "For the curious", monthlyCents: 2000 },
  max5x: { id: "max5x", name: "Claude Max 5x", tagline: "For the enthusiast", monthlyCents: 10000 },
  max20x: { id: "max20x", name: "Claude Max 20x", tagline: "For the power user", monthlyCents: 20000 },
};

const GIFT_MONTHS = [1, 3, 6, 12];

// Returns the price in cents, or null if the plan/months combo isn't offered.
function giftPriceCents(planId, months) {
  const plan = GIFT_PLANS[planId];
  if (!plan || !GIFT_MONTHS.includes(months)) return null;
  return plan.monthlyCents * months;
}

module.exports = { GIFT_PLANS, GIFT_MONTHS, giftPriceCents };
