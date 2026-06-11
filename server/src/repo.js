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

    // Called from the Stripe webhook when payment completes. Idempotent: only a
    // pending campaign activates, and the funding ledger entry rides the same tx.
    async activateCampaign(campaignId) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `update campaigns set status = 'active', activated_at = now()
            where id = $1 and status = 'pending_payment'
            returning price_per_block_cents, blocks`,
          [campaignId]
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
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out
         from ledger
         where device_id = $1
            or user_id = (select user_id from devices where id = $1 and user_id is not null)`,
        [deviceId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out); // stored negative
      return { earnedMillicents: earned, paidOutMillicents: -paidOut, balanceMillicents: earned + paidOut };
    },

    async linkDeviceToUser(deviceId, email) {
      return tx(async (c) => {
        const u = await c.query(
          `insert into users (email) values ($1)
           on conflict (email) do update set email = excluded.email
           returning id, stripe_account_id, payouts_enabled`,
          [email]
        );
        await c.query("update devices set user_id = $2 where id = $1", [deviceId, u.rows[0].id]);
        return u.rows[0];
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
             >= $1`,
        [thresholdMillicents]
      );
      return rows.map((r) => ({ ...r, balance: Number(r.balance) }));
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
