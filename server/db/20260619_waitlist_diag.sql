-- Provision tables the code referenced but prod was missing (schema drift from
-- the broken-CI period). All additive + idempotent.

-- ── Waitlists (#81): demand signal per surface ──────────────────────────────
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

create table if not exists waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  surface text not null references waitlist_surfaces(surface),
  created_at timestamptz not null default now(),
  unique (user_id, surface)
);
create index if not exists waitlist_signups_user_idx on waitlist_signups (user_id);
create index if not exists waitlist_signups_surface_idx on waitlist_signups (surface);

-- ── diag_errors: best-effort runtime error log (re-introduced) ──────────────
create table if not exists diag_errors (
  id bigserial primary key,
  method text,
  path text,
  message text,
  stack text,
  created_at timestamptz not null default now()
);
create index if not exists diag_errors_created_idx on diag_errors (created_at desc);
