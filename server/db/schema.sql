-- Betterbacks.ai — core schema (Postgres 14+)
-- Money rule: developers keep 90% of every dollar. The ledger is append-only;
-- balances are always derived from it, never stored.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
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
  price_per_block_cents integer not null check (price_per_block_cents >= 100),  -- min $1.00
  blocks integer not null check (blocks > 0),
  impressions_total integer not null,      -- blocks * 1000
  impressions_remaining integer not null,
  show_on_leaderboard boolean not null default true,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'exhausted', 'cancelled')),
  stripe_checkout_session_id text unique,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

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

-- Append-only money ledger. Amounts are in MILLICENTS (1/1000 cent) so a single
-- impression's 90% share is exact: $5 block -> 0.5c gross -> 450 millicents net.
create table if not exists ledger (
  id bigserial primary key,
  entry_type text not null check (entry_type in (
    'campaign_credit',     -- advertiser paid; campaign funded         (+ campaign)
    'impression_credit',   -- developer's 90% share of an impression   (+ device)
    'click_credit',        -- developer's 90% share of a click (50x)   (+ device)
    'platform_fee',        -- our 10%                                  (+ platform)
    'payout_debit'         -- transferred to developer's bank          (- user)
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
