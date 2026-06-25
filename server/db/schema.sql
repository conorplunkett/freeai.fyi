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
  price_per_block_cents integer not null check (price_per_block_cents >= 50),  -- the CPM (price per 1,000 impressions); min $0.50
  blocks integer not null check (blocks > 0),                                  -- legacy display count; impressions_total is authoritative
  impressions_total integer not null,      -- exact impressions purchased (floor(budget*1000/cpm)); not necessarily a multiple of 1000
  impressions_remaining integer not null,
  budget_cents integer,                    -- exact amount charged (the advertiser's budget); null on pre-budget campaigns
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
-- Exact charge (budget) for the budget+CPM checkout; older campaigns are null
-- and the funding code falls back to price_per_block_cents * blocks.
alter table campaigns add column if not exists budget_cents integer;

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

-- Email invites a user sends from the dashboard. The status tells the story of
-- one invitation: 'sent' (the email went out — the "sent" indicator), 'joined'
-- (the friend signed up with the code — the "code used" indicator), 'rewarded'
-- (they redeemed and the referrer was paid). One invite per (referrer, email);
-- re-inviting the same address just refreshes sent_at. The referrals table above
-- stays the source of truth for money; this table only tracks outreach + the two
-- indicators, joined to a referral by the friend's email.
create table if not exists referral_invites (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references users(id),
  email text not null,
  code text not null,
  status text not null default 'sent'
    check (status in ('sent', 'joined', 'rewarded')),
  sent_at timestamptz not null default now(),
  joined_at timestamptz,
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (referrer_user_id, email)
);
create index if not exists referral_invites_referrer_idx on referral_invites (referrer_user_id);
create index if not exists referral_invites_email_idx on referral_invites (lower(email));

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
  'referral_credit',     -- $20 bonus for a qualified referral        (+ user)
  'affiliate_credit'     -- 10% of an affiliated user's earnings      (+ user)
));

-- ── Affiliates ───────────────────────────────────────────────────────────────
-- A separate, application-gated program (distinct from referrals). A user
-- applies to become an affiliate by submitting their social handles + follower
-- counts; an admin reviews and approves, which mints a shareable affiliate code.
-- When a user signs up with — or retroactively applies — an affiliate code, the
-- affiliate earns 10% of that user's ad earnings as platform-funded bonus credits
-- (affiliate_credit), accrued continuously up to a per-affiliate cap. Affiliate
-- and referral attribution are mutually exclusive on a given user.
create table if not exists affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) unique,   -- the applicant
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  code text unique,                                     -- minted on approval, null until then
  instagram_handle text,
  instagram_followers integer check (instagram_followers is null or instagram_followers >= 0),
  linkedin_handle text,
  linkedin_followers integer check (linkedin_followers is null or linkedin_followers >= 0),
  twitter_handle text,
  twitter_followers integer check (twitter_followers is null or twitter_followers >= 0),
  reward_bps integer not null default 1000,             -- the affiliate's cut, basis points (1000 = 10%)
  cap_millicents bigint not null default 100000000,     -- legacy dollar cap (no longer enforced; kept for archive)
  cap_people integer not null default 1000,             -- the cap is now people-based: max attributed friends per affiliate
  credited_millicents bigint not null default 0,        -- running lifetime tally of credits earned (uncapped)
  review_note text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  -- any handle provided carries a follower count. (There is no "≥1 handle"
  -- constraint: the Chrome extension auto-enrolls every device-linked user as an
  -- approved affiliate with no socials — the self-serve "crew" path — while the
  -- admin application route still validates socials in code, parseAffiliateSocials.)
  constraint affiliates_followers_present check (
    (instagram_handle is null or instagram_followers is not null) and
    (linkedin_handle  is null or linkedin_followers  is not null) and
    (twitter_handle   is null or twitter_followers   is not null)
  )
);
create index if not exists affiliates_status_idx on affiliates (status);
-- Drop the legacy "at least one social handle" constraint on databases created
-- before self-serve enrollment, so handle-less auto-enrolled affiliates are valid.
alter table affiliates drop constraint if exists affiliates_handle_present;
-- The cap is now people-based (max attributed friends); add it for existing DBs.
alter table affiliates add column if not exists cap_people integer not null default 1000;

-- The affiliate this user is attributed to. Lives on users like referred_by, and
-- is mutually exclusive with it — a signup resolves to one or the other. Set at
-- signup or applied retroactively (referral codes can't be applied retroactively).
alter table users add column if not exists affiliate_id uuid references affiliates(id);

-- One row per attributed user (parallel to referrals); powers the affiliate's
-- "users referred" count. Unique on the user so attribution is one-time.
create table if not exists affiliate_attributions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references affiliates(id),
  affiliated_user_id uuid not null references users(id) unique,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_attributions_affiliate_idx on affiliate_attributions (affiliate_id);

-- ── Waitlists ────────────────────────────────────────────────────────────────
-- Users can join a waitlist to be notified when ads launch on a surface that
-- isn't live yet: the desktop app, the command line, the Chrome extension, and
-- the VS Code extension. The surfaces live in an enum-style reference table
-- (rather than a CHECK constraint) so adding a surface is a one-row INSERT, with
-- a human label and a display order, and no schema migration.
create table if not exists waitlist_surfaces (
  surface text primary key,
  label text not null,
  sort_order integer not null default 0
);
insert into waitlist_surfaces (surface, label, sort_order) values
  ('desktop',          'Ads on desktop',               1),
  ('command_line',     'Ads on the command line',      2),
  ('chrome_extension', 'Ads on the Chrome extension',  3),
  ('vscode_extension', 'Ads on the VS Code extension', 4)
on conflict (surface) do nothing;

-- One row per (user, surface) interest. The surface is a foreign key into the
-- enum table above, and the (user_id, surface) pair is unique so a re-signup is
-- a no-op; a single user may sit on several waitlists.
create table if not exists waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  surface text not null references waitlist_surfaces(surface),
  created_at timestamptz not null default now(),
  unique (user_id, surface)
);
create index if not exists waitlist_signups_user_idx on waitlist_signups (user_id);
create index if not exists waitlist_signups_surface_idx on waitlist_signups (surface);

-- ── First-login onboarding survey ───────────────────────────────────────────
-- Captured the first time a user signs in, before the refer-a-friend step:
-- which AI models they use and on which surfaces (both multi-select), plus an
-- optional free-text "other" surface. Stored as jsonb arrays so the same param
-- binding works across the Node (pg) and edge (postgres.js) drivers. One row per
-- user; the row's existence is the "survey done" signal /v1/web/me reports as
-- needsSurvey, gating the dashboard behind onboarding.
create table if not exists onboarding_surveys (
  user_id uuid primary key references users(id) on delete cascade,
  models jsonb not null default '[]'::jsonb,         -- e.g. ["claude","chatgpt"]
  surfaces jsonb not null default '[]'::jsonb,        -- e.g. ["browser_chrome","terminal"]
  surface_other text,                                 -- free text when "other" picked
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Pre-account email capture (launch waitlist) ─────────────────────────────
-- Bare email captures from the public landing pages — NO account, so this is
-- deliberately separate from waitlist_signups (which is keyed on a signed-in
-- user_id and tracks per-surface ad interest). One row per (email, kind):
-- 'earn' = "tell me when I can install and start earning"; kind is reserved so
-- other capture points (e.g. 'advertiser') can share the table later. Email is
-- normalized (lowercased/trimmed) by the API before insert, so the unique
-- (email, kind) makes a re-submit a no-op. source is a free-text hint of where
-- they signed up (page slug, e.g. 'index' or 'lander:gemini'); ip_hash is the
-- same HMAC(ip) the fraud caps use — never the raw IP.
create table if not exists email_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null default 'earn',
  source text,
  ip_hash text,
  created_at timestamptz not null default now(),
  unique (email, kind)
);
create index if not exists email_leads_kind_created_idx on email_leads (kind, created_at desc);

