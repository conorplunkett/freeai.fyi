-- FreeAI.fyi — core schema (Postgres 14+)
-- Money rule: developers keep 90% of every dollar. The ledger is append-only;
-- balances are always derived from it, never stored.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_verified boolean not null default false,  -- proven via magic-link before payout
  stripe_account_id text unique,           -- Stripe Connect Express account
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- A device = one machine running the extension. Devices earn anonymously from
-- day one; linking to a user (for payout) can happen later.
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  key_hash text not null,                  -- sha256 of the device secret
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Single-use magic-link tokens for email verification.
create table if not exists email_tokens (
  token text primary key,
  email text not null,
  device_id uuid references devices(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists advertisers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  advertiser_id uuid not null references advertisers(id),
  brand text,
  ad_line text not null check (char_length(ad_line) between 3 and 60),
  url text not null check (url like 'https://%'),
  category text not null default 'other',
  -- Advertiser-chosen accent color for the ad line, "#rrggbb"; null falls back
  -- to a per-brand color in the client.
  color text check (color is null or color ~* '^#[0-9a-f]{6}$'),
  price_per_block_cents integer not null check (price_per_block_cents >= 100),  -- min $1.00
  blocks integer not null check (blocks > 0),
  impressions_total integer not null,      -- blocks * 1000
  impressions_remaining integer not null,
  show_on_leaderboard boolean not null default true,
  -- lifecycle: pending_payment -> (paid) pending_review -> (approved) active
  --            -> exhausted; or rejected/cancelled.
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'pending_review', 'active', 'exhausted', 'rejected', 'cancelled')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,           -- captured for refunds on rejection
  review_note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  activated_at timestamptz
);

-- Backfill the color column on databases created before it existed.
alter table campaigns add column if not exists color text;

create index if not exists campaigns_auction_idx
  on campaigns (status, price_per_block_cents desc)
  where status = 'active';

-- Idempotency for event ingestion: each extension batch carries a unique key.
create table if not exists event_batches (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id),
  batch_key text not null unique,
  impressions integer not null default 0,
  clicks integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists event_batches_device_day_idx
  on event_batches (device_id, created_at);

-- Hashed source IP (an HMAC, never the raw address) recorded per batch. It backs
-- a per-IP daily impression cap that bounds farming across many anonymous
-- devices behind one host, and serves as a forensic key during the held-payout
-- review window. Added post-launch, so add-if-missing for existing databases.
alter table event_batches add column if not exists ip_hash text;
create index if not exists event_batches_ip_day_idx
  on event_batches (ip_hash, created_at);

-- Append-only money ledger. Amounts are in MILLICENTS (1/1000 cent) so a single
-- impression's 90% share is exact: $5 block -> 0.5c gross -> 450 millicents net.
create table if not exists ledger (
  id bigserial primary key,
  entry_type text not null check (entry_type in (
    'campaign_credit',     -- advertiser paid; campaign funded         (+ campaign)
    'campaign_refund',     -- rejected campaign refunded               (- campaign)
    'impression_credit',   -- developer's 90% share of an impression   (+ device)
    'click_credit',        -- developer's 90% share of a click (50x)   (+ device)
    'platform_fee',        -- our 10%                                  (+ platform)
    'payout_debit',        -- transferred to developer's bank          (- user)
    'gift_redemption_debit' -- redeemed for a Claude gift card         (- device)
  )),
  amount_millicents bigint not null,
  device_id uuid references devices(id),
  user_id uuid references users(id),
  campaign_id uuid references campaigns(id),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists ledger_device_idx on ledger (device_id);
create index if not exists ledger_user_idx on ledger (user_id);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount_cents integer not null check (amount_cents > 0),
  stripe_transfer_id text unique,
  status text not null default 'paid' check (status in ('paid', 'failed')),
  created_at timestamptz not null default now()
);

-- Claude gift card redemptions. A redemption deducts the balance via a
-- gift_redemption_debit ledger entry; fulfillment (the actual gift card email to
-- the user) is manual and lands within 48 hours. Redemptions happen only on the
-- website after the user logs in, so they're scoped to a user (a device_id is
-- kept for older device-scoped redemptions).
create table if not exists gift_redemptions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references devices(id),
  user_id uuid references users(id),
  plan text not null check (plan in ('pro', 'max5x', 'max20x')),
  months integer not null check (months in (1, 3, 6, 12)),
  amount_cents integer not null check (amount_cents > 0),
  recipient_email text not null,
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);
-- device_id predates user-scoped (website) redemptions; allow either.
alter table gift_redemptions add column if not exists user_id uuid references users(id);
alter table gift_redemptions alter column device_id drop not null;

-- Website login sessions. The user proves email ownership via a magic link, and
-- the redemption page carries this bearer token to read the balance and redeem.
-- OAuth provider IDs (added post-launch for Google/Apple sign-in)
alter table users add column if not exists google_id text unique;
alter table users add column if not exists apple_id text unique;

create table if not exists web_sessions (
  token text primary key,
  user_id uuid not null references users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists web_sessions_user_idx on web_sessions (user_id);

-- Stripe retries webhooks; this makes processing exactly-once.
create table if not exists processed_webhook_events (
  event_id text primary key,
  type text,
  created_at timestamptz not null default now()
);

-- Server-side click verification. The extension asks for a single-use token
-- (authenticated by deviceKey), and the ad link points at /v1/go/:token.
-- Hitting it once records the click and redirects — so clicks can't be forged
-- by editing the ad URL or replaying it.
create table if not exists click_tokens (
  token text primary key,
  campaign_id uuid not null references campaigns(id),
  device_id uuid not null references devices(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Referrals ──────────────────────────────────────────────────────────────
-- Every user gets a shareable referral_code (generated lazily). A new user may
-- be attributed to one referrer (referred_by), set only at first sign-in. When a
-- referred user completes their first gift-card redemption, the referrer earns a
-- one-time $20 credit, capped at 10 rewarded referrals per user.
alter table users add column if not exists referral_code text unique;
alter table users add column if not exists referred_by uuid references users(id);

-- The referral code is entered on the signup form, so it must travel with the
-- magic-link token from /v1/web/login through to user creation.
alter table email_tokens add column if not exists referral_code text;

-- One row per referred user. The status transition pending -> rewarded is the
-- idempotency guard that pays the referrer exactly once.
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references users(id),
  referred_user_id uuid not null references users(id) unique,
  status text not null default 'pending'
    check (status in ('pending', 'rewarded', 'capped', 'cancelled')),
  reward_millicents bigint not null default 0,
  rewarded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists referrals_referrer_idx on referrals (referrer_user_id);

-- Allow the referral bonus entry type in the ledger. Drop + re-add so re-running
-- the migration is idempotent and existing databases pick up the new value.
alter table ledger drop constraint if exists ledger_entry_type_check;
alter table ledger add constraint ledger_entry_type_check check (entry_type in (
  'campaign_credit',     -- advertiser paid; campaign funded         (+ campaign)
  'campaign_refund',     -- rejected campaign refunded               (- campaign)
  'impression_credit',   -- developer's 90% share of an impression   (+ device)
  'click_credit',        -- developer's 90% share of a click (50x)   (+ device)
  'platform_fee',        -- our 10%                                  (+ platform)
  'payout_debit',        -- transferred to developer's bank          (- user)
  'gift_redemption_debit', -- redeemed for a Claude gift card        (- device)
  'referral_credit'      -- $20 bonus for a qualified referral        (+ user)
));
