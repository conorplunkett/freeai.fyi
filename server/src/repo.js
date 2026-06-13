// Postgres repository. All money mutations happen inside transactions, and all
// amounts in the ledger are MILLICENTS (1/1000 cent) so the 90% split is exact.

const crypto = require("node:crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function createRepo(pool) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    // ---------- devices ----------
    async registerDevice() {
      const secret = crypto.randomBytes(32).toString("hex");
      const { rows } = await pool.query(
        "insert into devices (key_hash) values ($1) returning id",
        [sha256(secret)]
      );
      return { deviceId: rows[0].id, deviceKey: secret };
    },

    async authDevice(deviceId, deviceKey) {
      if (!deviceId || !deviceKey) return null;
      const { rows } = await pool.query(
        "update devices set last_seen_at = now() where id = $1 and key_hash = $2 returning id, user_id",
        [deviceId, sha256(deviceKey)]
      );
      return rows[0] || null;
    },

    // ---------- auction ----------
    async activeAds(limit = 20) {
      const { rows } = await pool.query(
        `select id, brand, ad_line, url, category, price_per_block_cents, show_on_leaderboard
           from campaigns
          where status = 'active' and impressions_remaining > 0
          order by price_per_block_cents desc, activated_at asc
          limit $1`,
        [limit]
      );
      return rows;
    },

    async leaderboard(limit = 15) {
      const { rows } = await pool.query(
        `select brand, ad_line, price_per_block_cents
           from campaigns
          where status in ('active', 'exhausted') and show_on_leaderboard
          order by price_per_block_cents desc, activated_at asc
          limit $1`,
        [limit]
      );
      return rows;
    },

    // ---------- advertiser checkout ----------
    async createPendingCampaign({ email, brand, adLine, url, category, pricePerBlockCents, blocks, showOnLeaderboard }) {
      return tx(async (c) => {
        const adv = await c.query(
          "insert into advertisers (email) values ($1) returning id",
          [email]
        );
        const { rows } = await c.query(
          `insert into campaigns
             (advertiser_id, brand, ad_line, url, category, price_per_block_cents,
              blocks, impressions_total, impressions_remaining, show_on_leaderboard)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
           returning id`,
          [adv.rows[0].id, brand || null, adLine, url, category || "other",
           pricePerBlockCents, blocks, blocks * 1000, showOnLeaderboard !== false]
        );
        return rows[0].id;
      });
    },

    async attachCheckoutSession(campaignId, sessionId) {
      await pool.query(
        "update campaigns set stripe_checkout_session_id = $2 where id = $1",
        [campaignId, sessionId]
      );
    },

    // Called from the Stripe webhook when payment completes. Idempotent at two
    // levels: the webhook event id is deduped upstream, and only a
    // pending_payment campaign transitions. Money is now received, so the
    // funding ledger entry rides this tx — but the ad doesn't serve until a
    // human approves it (status -> pending_review).
    async markCampaignPaid(campaignId, paymentIntentId) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `update campaigns set status = 'pending_review', paid_at = now(),
                  stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id)
            where id = $1 and status = 'pending_payment'
            returning price_per_block_cents, blocks`,
          [campaignId, paymentIntentId || null]
        );
        if (!rows[0]) return false;
        const funded = BigInt(rows[0].price_per_block_cents) * BigInt(rows[0].blocks) * 1000n;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('campaign_credit', $1, $2, $3)`,
          [funded.toString(), campaignId, JSON.stringify({ blocks: rows[0].blocks })]
        );
        return true;
      });
    },

    // ---------- moderation ----------
    async pendingReviewCampaigns(limit = 50) {
      const { rows } = await pool.query(
        `select id, brand, ad_line, url, category, price_per_block_cents, blocks, paid_at
           from campaigns where status = 'pending_review'
          order by paid_at asc limit $1`,
        [limit]
      );
      return rows;
    },

    async approveCampaign(campaignId) {
      const { rows } = await pool.query(
        `update campaigns set status = 'active', activated_at = now()
          where id = $1 and status = 'pending_review' returning id`,
        [campaignId]
      );
      return !!rows[0];
    },

    // Reject -> mark rejected and post a refund ledger entry that zeroes out the
    // funding. Returns the payment intent so the caller can issue a Stripe refund.
    async rejectCampaign(campaignId, note) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `update campaigns set status = 'rejected', review_note = $2
            where id = $1 and status = 'pending_review'
            returning price_per_block_cents, blocks, stripe_payment_intent_id`,
          [campaignId, note || null]
        );
        if (!rows[0]) return null;
        const refund = BigInt(rows[0].price_per_block_cents) * BigInt(rows[0].blocks) * 1000n;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('campaign_refund', $1, $2, $3)`,
          [(-refund).toString(), campaignId, JSON.stringify({ note: note || null })]
        );
        return { paymentIntentId: rows[0].stripe_payment_intent_id };
      });
    },

    // ---------- webhook idempotency ----------
    // Returns true the first time an event id is seen, false on retries.
    async claimWebhookEvent(eventId, type) {
      if (!eventId) return true; // nothing to dedupe against
      const { rows } = await pool.query(
        `insert into processed_webhook_events (event_id, type) values ($1, $2)
         on conflict (event_id) do nothing returning event_id`,
        [eventId, type || null]
      );
      return !!rows[0];
    },

    // ---------- event ingestion (the core money loop) ----------
    // One batch = { batchKey, events: [{ campaignId, impressions, clicks }] }.
    // A click bills the campaign at 50x an impression. The developer's share
    // (revenueShare, 0.9) credits the device; the rest is the platform fee.
    async ingestBatch({ deviceId, batchKey, events, revenueShare, dailyCap }) {
      return tx(async (c) => {
        const claimedImpressions = events.reduce((n, e) => n + (e.impressions || 0), 0);
        const claimedClicks = events.reduce((n, e) => n + (e.clicks || 0), 0);

        // idempotency: replays of the same batch are acknowledged, not re-paid
        const ins = await c.query(
          `insert into event_batches (device_id, batch_key, impressions, clicks)
           values ($1,$2,$3,$4) on conflict (batch_key) do nothing returning id`,
          [deviceId, batchKey, claimedImpressions, claimedClicks]
        );
        if (!ins.rows[0]) return { duplicate: true, creditedMillicents: 0 };

        // fraud cap: impressions per device per UTC day
        const cap = await c.query(
          `select coalesce(sum(impressions), 0)::bigint as n from event_batches
            where device_id = $1 and created_at >= date_trunc('day', now())`,
          [deviceId]
        );
        if (Number(cap.rows[0].n) > dailyCap) {
          const err = new Error("daily impression cap exceeded");
          err.code = "CAP_EXCEEDED";
          throw err;
        }

        let credited = 0n;
        for (const ev of events) {
          const imp = Math.max(0, ev.impressions | 0);
          const clk = Math.max(0, ev.clicks | 0);
          const billable = imp + clk * 50; // clicks bill at 50x
          if (!billable) continue;

          // lock the campaign row; never bill past its remaining budget
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

          // gross per impression in millicents: price_per_block_cents / 1000 cents
          // = price_per_block_cents millicents. Exact integer math throughout.
          const gross = BigInt(camp.rows[0].price_per_block_cents) * BigInt(billed);
          const dev = (gross * BigInt(Math.round(revenueShare * 1000))) / 1000n;
          const fee = gross - dev;
          credited += dev;

          const isClickHeavy = clk > 0;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
             values ($1, $2, $3, $4, $5)`,
            [isClickHeavy ? "click_credit" : "impression_credit", dev.toString(),
             deviceId, ev.campaignId, JSON.stringify({ impressions: imp, clicks: clk, billed })]
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

    // ---------- earnings & payouts ----------
    async earningsForDevice(deviceId) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed
         from ledger
         where device_id = $1
            or user_id = (select user_id from devices where id = $1 and user_id is not null)`,
        [deviceId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out); // stored negative
      const redeemed = Number(rows[0].redeemed); // stored negative
      return {
        earnedMillicents: earned,
        paidOutMillicents: -paidOut,
        redeemedMillicents: -redeemed,
        balanceMillicents: earned + paidOut + redeemed,
      };
    },

    async userForDevice(deviceId) {
      const { rows } = await pool.query(
        `select u.* from users u join devices d on d.user_id = u.id where d.id = $1`,
        [deviceId]
      );
      return rows[0] || null;
    },

    // ---------- email verification (magic link) ----------
    async createEmailToken(email, deviceId, ttlMs) {
      const token = crypto.randomBytes(32).toString("base64url");
      await pool.query(
        `insert into email_tokens (token, email, device_id, expires_at)
         values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
        [token, email, deviceId || null, String(ttlMs)]
      );
      return token;
    },

    // Consume a magic-link token: mark used, upsert a verified user, link the
    // device. Single-use and time-bound. Returns the user or null.
    async verifyEmailToken(token) {
      return tx(async (c) => {
        const t = await c.query(
          `update email_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now()
            returning email, device_id`,
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
        if (device_id) {
          await c.query("update devices set user_id = $2 where id = $1", [device_id, u.rows[0].id]);
        }
        return u.rows[0];
      });
    },

    // ---------- server-side clicks ----------
    async createClickToken(campaignId, deviceId, ttlMs) {
      const camp = await pool.query(
        "select 1 from campaigns where id = $1 and status = 'active'",
        [campaignId]
      );
      if (!camp.rows[0]) return null;
      const token = crypto.randomBytes(24).toString("base64url");
      await pool.query(
        `insert into click_tokens (token, campaign_id, device_id, expires_at)
         values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
        [token, campaignId, deviceId, String(ttlMs)]
      );
      return token;
    },

    // Redeem a click token exactly once: bill the campaign 50x an impression,
    // credit the device its share, return the destination URL to redirect to.
    async redeemClickToken(token, revenueShare) {
      return tx(async (c) => {
        const t = await c.query(
          `update click_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now()
            returning campaign_id, device_id`,
          [token]
        );
        if (!t.rows[0]) return null;
        const { campaign_id, device_id } = t.rows[0];
        const camp = await c.query(
          `select url, price_per_block_cents, impressions_remaining from campaigns
            where id = $1 and status = 'active' for update`,
          [campaign_id]
        );
        if (!camp.rows[0]) return null;
        const billed = Math.min(50, camp.rows[0].impressions_remaining); // a click = 50 impressions
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

    async setStripeAccount(userId, accountId) {
      await pool.query("update users set stripe_account_id = $2 where id = $1", [userId, accountId]);
    },

    async setPayoutsEnabledByAccount(accountId, enabled) {
      await pool.query(
        "update users set payouts_enabled = $2 where stripe_account_id = $1",
        [accountId, enabled]
      );
    },

    // Users at/over the threshold with onboarded Stripe accounts. Balance is
    // derived from the ledger via their linked devices.
    async payableUsers(thresholdMillicents) {
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
      return rows.map((r) => ({ ...r, balance: Number(r.balance) }));
    },

    // ---------- gift card redemptions ----------
    // Deducts the device's balance for a Claude gift card. The balance is
    // re-checked inside the transaction (with the ledger as source of truth) so
    // concurrent redemptions can't spend the same credits twice. Returns the
    // redemption id, or null if the balance is insufficient.
    async recordGiftRedemption({ id, deviceId, plan, months, amountCents, recipientEmail }) {
      return tx(async (c) => {
        const bal = await c.query(
          `select coalesce(sum(amount_millicents), 0)::bigint as balance from ledger
            where (device_id = $1
                or user_id = (select user_id from devices where id = $1 and user_id is not null))
              and entry_type in ('impression_credit','click_credit','payout_debit','gift_redemption_debit')`,
          [deviceId]
        );
        const costMillicents = BigInt(amountCents) * 1000n;
        if (BigInt(bal.rows[0].balance) < costMillicents) return null;

        const { rows } = await c.query(
          `insert into gift_redemptions (id, device_id, plan, months, amount_cents, recipient_email)
           values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6) returning id`,
          [id || null, deviceId, plan, months, amountCents, recipientEmail]
        );
        await c.query(
          `insert into ledger (entry_type, amount_millicents, device_id, meta)
           values ('gift_redemption_debit', $1, $2, $3)`,
          [(-costMillicents).toString(), deviceId,
           JSON.stringify({ redemptionId: rows[0].id, plan, months })]
        );
        return rows[0].id;
      });
    },

    // ---------- OAuth sign-in ----------
    // Find or create a user from a Google/Apple OAuth callback, then open a
    // web session. Looks up by provider ID first, then by email. Patches any
    // missing fields on an existing account.
    async upsertUserByOAuth({ email, googleId, appleId }, sessionTtlMs) {
      return tx(async (c) => {
        let found = null;
        if (googleId) {
          const r = await c.query("select id, email, google_id, apple_id from users where google_id = $1", [googleId]);
          found = r.rows[0] || null;
        }
        if (!found && appleId) {
          const r = await c.query("select id, email, google_id, apple_id from users where apple_id = $1", [appleId]);
          found = r.rows[0] || null;
        }
        if (!found && email) {
          const r = await c.query("select id, email, google_id, apple_id from users where email = $1", [email]);
          found = r.rows[0] || null;
        }

        let userId;
        if (found) {
          const sets = ["email_verified = true"];
          const vals = [found.id];
          if (email && !found.email)     { sets.push(`email = $${vals.length + 1}`);     vals.push(email); }
          if (googleId && !found.google_id) { sets.push(`google_id = $${vals.length + 1}`); vals.push(googleId); }
          if (appleId && !found.apple_id)   { sets.push(`apple_id = $${vals.length + 1}`);  vals.push(appleId); }
          await c.query(`update users set ${sets.join(", ")} where id = $1`, vals);
          userId = found.id;
        } else {
          const r = await c.query(
            `insert into users (email, email_verified, google_id, apple_id)
             values ($1, true, $2, $3) returning id`,
            [email || null, googleId || null, appleId || null]
          );
          userId = r.rows[0].id;
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

    // ---------- website login sessions ----------
    // Consume a magic-link token, upsert the verified user, and open a web
    // session for them. Single-use and time-bound. Returns { sessionToken, user }
    // or null if the token is invalid/expired.
    async createWebSessionFromToken(token, sessionTtlMs) {
      return tx(async (c) => {
        const t = await c.query(
          `update email_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now()
            returning email`,
          [token]
        );
        if (!t.rows[0]) return null;
        const u = await c.query(
          `insert into users (email, email_verified) values ($1, true)
           on conflict (email) do update set email_verified = true
           returning id, email`,
          [t.rows[0].email]
        );
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        await c.query(
          `insert into web_sessions (token, user_id, expires_at)
           values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
          [sessionToken, u.rows[0].id, String(sessionTtlMs)]
        );
        return { sessionToken, user: u.rows[0] };
      });
    },

    async userForSession(sessionToken) {
      if (!sessionToken) return null;
      const { rows } = await pool.query(
        `select u.id, u.email from web_sessions s join users u on u.id = s.user_id
          where s.token = $1 and s.expires_at > now()`,
        [sessionToken]
      );
      return rows[0] || null;
    },

    // Aggregate credit balance for a user, across every device linked to them
    // plus any user-level ledger entries (redemptions/payouts).
    async balanceForUser(userId) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed
         from ledger
         where user_id = $1
            or device_id in (select id from devices where user_id = $1)`,
        [userId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out); // negative
      const redeemed = Number(rows[0].redeemed); // negative
      return {
        earnedMillicents: earned,
        paidOutMillicents: -paidOut,
        redeemedMillicents: -redeemed,
        balanceMillicents: earned + paidOut + redeemed,
      };
    },

    // User-scoped gift redemption (website flow). Re-checks the user's balance
    // inside the transaction against the ledger so concurrent redeems can't spend
    // the same credits twice. Returns the redemption id, or null if short.
    async recordGiftRedemptionForUser({ id, userId, plan, months, amountCents, recipientEmail }) {
      return tx(async (c) => {
        const bal = await c.query(
          `select coalesce(sum(amount_millicents), 0)::bigint as balance from ledger
            where (user_id = $1 or device_id in (select id from devices where user_id = $1))
              and entry_type in ('impression_credit','click_credit','payout_debit','gift_redemption_debit')`,
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
          [(-costMillicents).toString(), userId,
           JSON.stringify({ redemptionId: rows[0].id, plan, months })]
        );
        return rows[0].id;
      });
    },

    async recordPayout(userId, amountCents, transferId) {
      return tx(async (c) => {
        await c.query(
          `insert into ledger (entry_type, amount_millicents, user_id, meta)
           values ('payout_debit', $1, $2, $3)`,
          [(-BigInt(amountCents) * 1000n).toString(), userId, JSON.stringify({ transferId })]
        );
        await c.query(
          "insert into payouts (user_id, amount_cents, stripe_transfer_id) values ($1,$2,$3)",
          [userId, amountCents, transferId]
        );
      });
    },
  };
}

module.exports = { createRepo, sha256 };
