-- Advertiser metrics + campaign-completion receipt emails (post-launch migration).
--   1) Unify advertisers by email (one advertiser owns many campaigns): merge any
--      pre-existing duplicate rows onto the earliest, repoint their campaigns, drop
--      the orphans, then enforce UNIQUE(email).
--   2) A per-campaign guard column so the "campaign finished" receipt sends once.
--   3) An index backing the per-campaign metric rollups (clicks / impressions-shown
--      / spend), all of which read the ledger filtered by campaign + entry_type.
--   4) Ensure the settings table exists (auto-send toggle lives here).
--
-- All idempotent so re-running is safe; the same statements live in schema.sql.

-- 1) unify advertisers by email. Repoint campaigns off duplicate advertiser rows
-- onto the surviving (earliest) row for that email *before* deleting duplicates
-- (advertiser_id is NOT NULL).
update campaigns c
   set advertiser_id = keep.id
  from advertisers a,
       (select distinct on (email) email, id from advertisers order by email, created_at, id) keep
 where c.advertiser_id = a.id and a.email = keep.email and c.advertiser_id <> keep.id;

delete from advertisers a
 using (select distinct on (email) email, id from advertisers order by email, created_at, id) keep
 where a.email = keep.email and a.id <> keep.id;

create unique index if not exists advertisers_email_key on advertisers (email);

-- 2) campaign-receipt guard
alter table campaigns add column if not exists completion_email_sent_at timestamptz;

-- 3) per-campaign ledger rollup index
create index if not exists ledger_campaign_idx on ledger (campaign_id, entry_type);

-- 4) settings table (no-op where 20260619_admin.sql already created it)
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
