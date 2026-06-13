-- FreeAI.fyi — seed one live entry.
-- Inserts a single active campaign so /v1/ads and /v1/leaderboard return one row
-- on a fresh database. Safe to re-run (fixed ids + on conflict do nothing).
-- Edit the brand / ad_line / url below, or delete this file once real campaigns
-- exist. Amounts: price_per_block_cents >= 100 ($1.00), 1 block = 1,000 impressions.

insert into advertisers (id, email)
values ('00000000-0000-0000-0000-0000000000a1', 'ads@freeai.fyi')
on conflict (id) do nothing;

insert into campaigns (
  id, advertiser_id, brand, ad_line, url, category,
  price_per_block_cents, blocks, impressions_total, impressions_remaining,
  show_on_leaderboard, status, paid_at, activated_at
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000a1',
  'FreeAI',
  'FreeAI — get Claude for free with ads.',
  'https://freeai.fyi',
  'other',
  500, 10, 10000, 10000,
  true, 'active', now(), now()
) on conflict (id) do nothing;
