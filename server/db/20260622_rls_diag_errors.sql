-- Security: diag_errors had RLS disabled, so the anon key could read the error
-- log via the Data API. Enable RLS (deny-all to anon/authenticated). The API
-- writes/reads via the service-role connection, which bypasses RLS, so error
-- logging and the admin dashboard are unaffected.
alter table public.diag_errors enable row level security;
