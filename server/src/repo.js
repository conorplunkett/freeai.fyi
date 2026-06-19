// Postgres repository. All money mutations happen inside transactions, and all
// amounts in the ledger are MILLICENTS (1/1000 cent) so the revenue split is exact.

const crypto = require("node:crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Referral codes are short, human-shareable, and avoid ambiguous glyphs
// (no 0/O/1/I) so they survive being typed by hand.
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateReferralCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return out;
}

// Mask a referred friend's email for the dashboard: keep the first local-part
// character and the domain, hide the rest (jane@acme.com -> j•••@acme.com). The
// referrer can recognise who they referred without the page leaking the full
// address of someone who signed up through their link.
function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at < 1) return "•••";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.length > 1 ? local[0] : "";
  return `${head}•••@${domain}`;
}

// Advisory-lock namespace (classid) for redemption serialization. Concurrent
// redeems that draw on the same balance take pg_advisory_xact_lock under this
// class so the in-transaction balance check can't be raced into an overdraft.
const LOCK_REDEEM = 0x52454431; // "RED1"

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

  // Attribute a brand-new user to a referrer. Called inside the user-creation
  // transaction, and only on first sign-in, so a code can never be applied to an
  // existing account. Unknown codes and self-referrals are silently ignored.
  async function applyReferral(client, newUserId, refCode) {
    if (!refCode) return;
    const code = String(refCode).trim().toUpperCase();
    if (!code) return;
    const r = await client.query(
      "select id from users where upper(referral_code) = $1",
      [code]
    );
    const referrer = r.rows[0];
    if (!referrer || referrer.id === newUserId) return;
    await client.query(
      "update users set referred_by = $2 where id = $1 and referred_by is null",
      [newUserId, referrer.id]
    );
    await client.query(
      `insert into referrals (referrer_user_id, referred_user_id, status)
       values ($1, $2, 'pending')
       on conflict (referred_user_id) do nothing`,
      [referrer.id, newUserId]
    );
    // Flip the "code used" indicator on a matching email invite, if the referrer
    // had invited this exact address. Matched by email so it survives the OAuth /
    // magic-link round-trip; harmless when the friend signed up some other way.
    const ne = await client.query("select email from users where id = $1", [newUserId]);
    if (ne.rows[0]?.email) {
      await client.query(
        `update referral_invites set status = 'joined', joined_at = now()
          where referrer_user_id = $1 and lower(email) = lower($2) and status = 'sent'`,
        [referrer.id, ne.rows[0].email]
      );
    }
  }

  // Pay the referrer their one-time bonus once the referred user redeems. The
  // pending -> rewarded transition (selected FOR UPDATE) is the idempotency guard
  // so repeat redemptions never double-credit. Past the cap, the referral is
  // marked 'capped' and no credit is posted.
  async function maybeRewardReferral(client, referredUserId, rewardMillicents, cap) {
    const ref = await client.query(
      `select id, referrer_user_id from referrals
        where referred_user_id = $1 and status = 'pending' for update`,
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
      [String(rewardMillicents), referrer_user_id,
       JSON.stringify({ referralId: id, referredUserId })]
    );
    await client.query(
      `update referrals set status = 'rewarded', rewarded_at = now(), reward_millicents = $2
        where id = $1`,
      [id, String(rewardMillicents)]
    );
    // Advance a matching email invite to its final 'rewarded' stage too.
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
        `select id, brand, ad_line, url, category, color, price_per_block_cents, show_on_leaderboard
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
    async createPendingCampaign({ email, brand, adLine, url, category, color, pricePerBlockCents, blocks, showOnLeaderboard }) {
      return tx(async (c) => {
        const adv = await c.query(
          "insert into advertisers (email) values ($1) returning id",
          [email]
        );
        const { rows } = await c.query(
          `insert into campaigns
             (advertiser_id, brand, ad_line, url, category, color, price_per_block_cents,
              blocks, impressions_total, impressions_remaining, show_on_leaderboard)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
           returning id`,
          [adv.rows[0].id, brand || null, adLine, url, category || "other", color || null,
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
    // Returns the campaign + advertiser details on the first (transitioning)
    // call so the caller can email a receipt, or false on a no-op (already paid
    // / unknown). The receipt thus rides the same exactly-once guarantee as the
    // funding ledger entry.
    async markCampaignPaid(campaignId, paymentIntentId) {
      return tx(async (c) => {
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
    // funding. Returns the payment intent (so the caller can issue a Stripe
    // refund) plus the advertiser + campaign details (so the caller can email
    // the advertiser). Null on a no-op (unknown / not in review).
    async rejectCampaign(campaignId, note) {
      return tx(async (c) => {
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
    // A click bills the campaign at 50x an impression. The user's share
    // (revenueShare, 0.5 by default) credits the device; the rest is the platform fee.
    async ingestBatch({ deviceId, batchKey, events, revenueShare, dailyCap, ipHash, ipDailyCap }) {
      return tx(async (c) => {
        const claimedImpressions = events.reduce((n, e) => n + (e.impressions || 0), 0);
        const claimedClicks = events.reduce((n, e) => n + (e.clicks || 0), 0);

        // idempotency: replays of the same batch are acknowledged, not re-paid
        const ins = await c.query(
          `insert into event_batches (device_id, batch_key, impressions, clicks, ip_hash)
           values ($1,$2,$3,$4,$5) on conflict (batch_key) do nothing returning id`,
          [deviceId, batchKey, claimedImpressions, claimedClicks, ipHash || null]
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

        // fraud cap: impressions per source IP per UTC day. Devices are free and
        // anonymous, so the per-device cap alone doesn't stop one host minting
        // many devices — this bounds the whole IP. Hashed, fail-open (skipped
        // when no IP is known), and disabled when ipDailyCap is not positive so
        // operators with large shared-NAT/CGNAT audiences can opt out.
        if (ipHash && Number.isFinite(ipDailyCap) && ipDailyCap > 0) {
          const ipCap = await c.query(
            `select coalesce(sum(impressions), 0)::bigint as n from event_batches
              where ip_hash = $1 and created_at >= date_trunc('day', now())`,
            [ipHash]
          );
          if (Number(ipCap.rows[0].n) > ipDailyCap) {
            const err = new Error("daily ip impression cap exceeded");
            err.code = "CAP_EXCEEDED";
            throw err;
          }
        }

        let credited = 0n;
        for (const ev of events) {
          const imp = Math.max(0, ev.impressions | 0);
          // Clicks are NOT billed here. Self-reported click counts are
          // unverifiable, bill at 50x, and would bypass the daily cap (which is
          // keyed on impressions) — so a direct API caller could mint unlimited
          // credit. Genuine clicks are credited only through the single-use,
          // forgery-proof token path (/v1/clicks/intent -> /v1/go/:token).
          const billable = imp;
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

    // ---------- earnings & payouts ----------
    async earningsForDevice(deviceId) {
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
    async createEmailToken(email, deviceId, ttlMs, referralCode) {
      const token = crypto.randomBytes(32).toString("base64url");
      await pool.query(
        `insert into email_tokens (token, email, device_id, referral_code, expires_at)
         values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
        [token, email, deviceId || null, referralCode || null, String(ttlMs)]
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
    async redeemClickToken(token, revenueShare, dailyClickCap) {
      return tx(async (c) => {
        const t = await c.query(
          `update click_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now()
            returning campaign_id, device_id`,
          [token]
        );
        if (!t.rows[0]) return null;
        const { campaign_id, device_id } = t.rows[0];

        // Per-device daily click cap. A click bills 50x an impression, so an
        // uncapped click path lets one device drain a campaign's budget and mint
        // credit in a loop. Past the cap we still 302 the user onward (clean UX)
        // but credit nothing — the analogue of the impression daily cap.
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
        const billed = overCap ? 0 : Math.min(50, camp.rows[0].impressions_remaining); // a click = 50 impressions
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
    // ---------- OAuth sign-in ----------
    // Find or create a user from a Google/Apple OAuth callback, then open a
    // web session. Looks up by provider ID first, then by email. Patches any
    // missing fields on an existing account.
    async upsertUserByOAuth({ email, googleId, appleId, referralCode, emailVerified }, sessionTtlMs) {
      return tx(async (c) => {
        // Only a provider-verified email may match or merge into an existing
        // account — otherwise an attacker who controls an OAuth identity with an
        // unverified email claim could take over a victim's account (and its
        // balance) by email. Unverified emails are dropped; the provider id is
        // the only trusted key.
        const matchEmail = emailVerified ? (email || null) : null;

        let found = null;
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
          const vals = [found.id];
          if (matchEmail && !found.email)   { sets.push(`email = $${vals.length + 1}`);     vals.push(matchEmail); }
          if (googleId && !found.google_id) { sets.push(`google_id = $${vals.length + 1}`); vals.push(googleId); }
          if (appleId && !found.apple_id)   { sets.push(`apple_id = $${vals.length + 1}`);  vals.push(appleId); }
          await c.query(`update users set ${sets.join(", ")} where id = $1`, vals);
          userId = found.id;
        } else {
          const r = await c.query(
            `insert into users (email, email_verified, google_id, apple_id)
             values ($1, true, $2, $3) returning id`,
            [matchEmail || null, googleId || null, appleId || null]
          );
          userId = r.rows[0].id;
          await applyReferral(c, userId, referralCode); // first sign-in only
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
            returning email, referral_code`,
          [token]
        );
        if (!t.rows[0]) return null;
        // (xmax = 0) is true only for a fresh INSERT, false when ON CONFLICT
        // updated an existing row — so we apply the referral on first sign-in only.
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
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit')), 0)::bigint as earned,
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

    // Earnings tracking for the web dashboard. Lifetime / today / month-to-date
    // credit totals plus the same balance math as balanceForUser, in one pass.
    // "Today" and "this month" are bucketed in UTC (date_trunc on now()).
    async earningsForUser(userId) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit') and created_at >= date_trunc('day', now())), 0)::bigint as today,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit') and created_at >= date_trunc('month', now())), 0)::bigint as month,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed
         from ledger
         where user_id = $1
            or device_id in (select id from devices where user_id = $1)`,
        [userId]
      );
      const earned = Number(rows[0].earned);
      const today = Number(rows[0].today);
      const month = Number(rows[0].month);
      const paidOut = Number(rows[0].paid_out); // negative
      const redeemed = Number(rows[0].redeemed); // negative
      return {
        lifetimeMillicents: earned,
        todayMillicents: today,
        monthMillicents: month,
        redeemedMillicents: -redeemed,
        paidOutMillicents: -paidOut,
        balanceMillicents: earned + paidOut + redeemed,
      };
    },

    // Time-bucketed credit totals for the earnings chart. `bucket` is 'hour' or
    // 'day'; only buckets with activity at/after `since` are returned (the caller
    // fills the gaps to a continuous axis). Ordered oldest-first.
    async earningsSeriesForUser(userId, { bucket, since }) {
      const unit = bucket === "hour" ? "hour" : "day";
      const { rows } = await pool.query(
        `select
           date_trunc($2, created_at) as t,
           coalesce(sum(amount_millicents), 0)::bigint as millicents,
           count(*)::int as count
         from ledger
         where (user_id = $1 or device_id in (select id from devices where user_id = $1))
           and entry_type in ('impression_credit','click_credit','referral_credit')
           and created_at >= $3
         group by 1
         order by 1 asc`,
        [userId, unit, since]
      );
      return rows.map((r) => ({
        t: r.t,
        millicents: Number(r.millicents),
        count: r.count,
      }));
    },

    // Recent credited ledger rows for the activity ledger (newest first). Credits
    // only — redemptions/payouts are excluded. `limit` is clamped to [1, 200].
    async recentCreditsForUser(userId, limit) {
      const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 200));
      const { rows } = await pool.query(
        `select l.id, l.created_at, l.entry_type, l.amount_millicents, l.meta, c.brand
           from ledger l
           left join campaigns c on c.id = l.campaign_id
          where (l.user_id = $1 or l.device_id in (select id from devices where user_id = $1))
            and l.entry_type in ('impression_credit','click_credit','referral_credit')
          order by l.created_at desc
          limit $2`,
        [userId, n]
      );
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        entryType: r.entry_type,
        amountMillicents: Number(r.amount_millicents),
        advertiser: r.brand || null,
        meta: r.meta || {},
      }));
    },

    // User-scoped gift redemption (website flow). Re-checks the user's balance
    // inside the transaction against the ledger so concurrent redeems can't spend
    // the same credits twice. Returns the redemption id, or null if short.
    async recordGiftRedemptionForUser({ id, userId, plan, months, amountCents, recipientEmail, referralRewardMillicents, referralCap }) {
      return tx(async (c) => {
        // Serialize concurrent redeems on this user's balance (see
        // recordGiftRedemption) so the in-transaction check can't be overdrawn.
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
          [(-costMillicents).toString(), userId,
           JSON.stringify({ redemptionId: rows[0].id, plan, months })]
        );
        // Redeeming is what qualifies this user's referrer for their $20 bonus.
        if (referralRewardMillicents) {
          await maybeRewardReferral(c, userId, referralRewardMillicents, referralCap ?? 10);
        }
        return rows[0].id;
      });
    },

    // ---------- referrals ----------
    // Return the user's shareable code, minting a unique one on first request.
    // Lazy creation means existing users are backfilled with no data migration.
    async getOrCreateReferralCode(userId) {
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
          // a concurrent request set it first — re-read and return that one
          const re = await pool.query("select referral_code from users where id = $1", [userId]);
          if (re.rows[0]?.referral_code) return re.rows[0].referral_code;
        } catch (err) {
          if (err.code === "23505") continue; // code collided with another user; retry
          throw err;
        }
      }
      throw new Error("could not allocate referral code");
    },

    // Record (or re-send) an email invite. Stored lower-cased so the email match
    // that flips the 'joined'/'rewarded' indicators is case-insensitive. The
    // self-referral guard ("can't refer your own email") lives in the route,
    // which knows the caller's email. Returns the invite row.
    async createReferralInvite(referrerUserId, email, code) {
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

    // Counts + the dashboard list, one row per friend with their email and the
    // stage they're at: 'invited' (email sent, not signed up yet) comes from
    // referral_invites; 'pending'/'rewarded'/'capped'/'cancelled' come from the
    // referrals table joined to the friend's account. Both lists merge into one
    // newest-first timeline so the user can see exactly who they've referred.
    async referralStats(userId) {
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
          where r.referrer_user_id = $1
          order by r.created_at desc limit 100`,
        [userId]
      );
      // Only invites still awaiting a signup; once joined, the friend shows up in
      // `joined` above (matched by email), so this avoids double-listing them.
      const invited = await pool.query(
        `select email, sent_at as created_at from referral_invites
          where referrer_user_id = $1 and status = 'sent'
          order by sent_at desc limit 100`,
        [userId]
      );
      const s = stats.rows[0];
      const referrals = [
        ...invited.rows.map((r) => ({ email: maskEmail(r.email), status: "invited", createdAt: r.created_at })),
        ...joined.rows.map((r) => ({ email: maskEmail(r.email), status: r.status, createdAt: r.created_at })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return {
        rewardedCount: s.rewarded,
        pendingCount: s.pending,
        cappedCount: s.capped,
        invitedCount: invited.rows.length,
        creditsEarnedMillicents: Number(s.earned_millicents),
        referrals,
      };
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

    // ---------- waitlists ----------
    // The surfaces a user can join a waitlist for, read from the enum table so a
    // new surface is a data change, not a deploy. Ordered for display.
    async listWaitlistSurfaces() {
      const { rows } = await pool.query(
        "select surface, label from waitlist_surfaces order by sort_order asc, surface asc"
      );
      return rows;
    },

    // Record a user's interest in one surface. Idempotent: a repeat signup is a
    // no-op (the unique (user_id, surface) constraint). Returns true when a new
    // row was created, false when the user was already on this waitlist.
    async joinWaitlist(userId, surface) {
      const { rows } = await pool.query(
        `insert into waitlist_signups (user_id, surface) values ($1, $2)
         on conflict (user_id, surface) do nothing returning id`,
        [userId, surface]
      );
      return !!rows[0];
    },

    // The surfaces this user has already joined, oldest first.
    async waitlistsForUser(userId) {
      const { rows } = await pool.query(
        "select surface, created_at from waitlist_signups where user_id = $1 order by created_at asc",
        [userId]
      );
      return rows;
    },
  };
}

module.exports = { createRepo, sha256 };
