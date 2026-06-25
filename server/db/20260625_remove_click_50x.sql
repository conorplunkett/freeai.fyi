-- Remove the 50x click billing — clicks become free, but still tracked.
--
-- Before: a verified click (/v1/clicks/intent -> /v1/go/:token) billed the
-- campaign 50x an impression: it drew up to 50 budget units, wrote a
-- 'click_credit' ledger row (the earner's share) + a 'platform_fee' row, and
-- accrued affiliate credit.
-- After: the redirect records a single zero-value 'click_event' row — no budget
-- draw, no payout, no fee, no affiliate credit. Clicks cost advertisers nothing
-- and pay earners nothing, but stay tracked so the click-through link and the
-- CTR/CPC/eCPM metrics keep working.
--
-- This migration only WIDENS the ledger entry-type CHECK to allow 'click_event';
-- the behavior change lives in the API (redeemClickToken) and the metric COUNTs.
-- Historical 'click_credit' rows are left untouched (past earnings preserved).
-- Idempotent; the same final constraint lives in schema.sql.

-- The full set mirrors production's current constraint (verified live) plus
-- 'click_event'. NOT VALID + VALIDATE keeps the lock light on the hot ledger
-- table; this is a pure relaxation, so every existing row already passes.
alter table ledger drop constraint if exists ledger_entry_type_check;
alter table ledger add constraint ledger_entry_type_check check (entry_type in (
  'campaign_credit',       -- advertiser paid; campaign funded          (+ campaign)
  'campaign_refund',       -- rejected campaign refunded                (- campaign)
  'impression_credit',     -- developer's 90% share of an impression    (+ device)
  'click_credit',          -- legacy: developer's share of a 50x click (retired; kept for history)
  'click_event',           -- a verified click, recorded for analytics only (amount 0; never billed)
  'platform_fee',          -- our 10%                                   (+ platform)
  'payout_debit',          -- transferred to developer's bank           (- user)
  'gift_redemption_debit', -- redeemed for a Claude gift card           (- device)
  'referral_credit',       -- $20 bonus for a qualified referral         (+ user)
  'affiliate_credit',      -- 10% of an affiliated user's earnings       (+ user)
  'admin_credit',          -- manual balance adjustment up   (admin)    (+ user/device)
  'admin_debit'            -- manual balance adjustment down (admin)    (- user/device)
)) not valid;
alter table ledger validate constraint ledger_entry_type_check;
