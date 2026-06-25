-- 20260624_email_leads — pre-account email capture (launch waitlist)
--
-- A bare email-capture table for the public landing pages: someone types their
-- email under the hero ("Join the waitlist to earn") and we store it with no
-- account, no magic link. This is intentionally separate from waitlist_signups,
-- which is keyed on a signed-in users(id) and tracks per-surface ad interest.
--
-- One row per (email, kind). The API normalizes email (lowercase/trim) before
-- insert, so `unique (email, kind)` makes a re-submit a clean no-op. `source` is
-- a free-text hint of where they signed up (page slug, e.g. 'index' or
-- 'lander:gemini'); `ip_hash` is the same HMAC(ip) the fraud caps use — the raw
-- IP is never stored.
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

-- Security: every other table has RLS on, so collected emails must too — without
-- it the anon key could read this list via the Data API. Deny-all (no policies);
-- the API writes via the service-role/direct connection, which bypasses RLS.
alter table public.email_leads enable row level security;
