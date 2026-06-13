# Supabase Edge Functions — the FreeAI backend

The production API runs here, as Supabase Edge Functions (Deno), on the same
platform as the database. This replaced the Node `node:http` server that was
deployed on Fly.io. The Node implementation is kept in `server/` as the tested
reference + rollback (the Edge port mirrors its routes and SQL verbatim).

## Functions

- **`api/`** — the whole API, ported from `server/src/*` into one function.
  Served under the slug `api`, so the public base is
  `https://<ref>.supabase.co/functions/v1/api` and routes arrive as `/api/v1/…`
  (the slug prefix is stripped, then the original paths are matched). Uses
  `npm:pg` against `SUPABASE_DB_URL` (the Supavisor pooler) so the data layer is
  a near-verbatim copy of `server/src/repo.js` — same transactions, same
  `pg_advisory_xact_lock` redemption guard, same millicent BigInt math.
- **`web-referrals/`** — the original single-route proof-of-concept. Superseded
  by `api/`; kept for reference and safe to delete.

Both deploy with `verify_jwt=false`: the API does its own auth (web-session
tokens, device keys, admin key, OAuth, Stripe webhook signatures), not Supabase
JWTs.

## Required secrets (set in the Supabase dashboard → Edge Functions → Secrets)

`SUPABASE_DB_URL` and `SUPABASE_URL` are injected automatically. Set the rest:

| Secret | Needed for |
| --- | --- |
| `STRIPE_SECRET_KEY` | advertiser checkout, refunds, payouts |
| `STRIPE_WEBHOOK_SECRET` | verifying `/v1/webhooks/stripe` |
| `ADMIN_KEY` | `/admin`, moderation, killswitch, payouts, OAuth-state HMAC |
| `RESEND_API_KEY` + `MAIL_PROVIDER=resend` + `MAIL_FROM` | sending login / verify / fulfillment email |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple sign-in |
| `SITE_URL` | redirect targets (defaults to `https://freeai.fyi`) |
| `API_BASE_URL` | optional; defaults to `${SUPABASE_URL}/functions/v1/api` |

## External console changes that go with this migration

The API host moved off `api.freeai.fyi`, so update these to the new base
(`https://<ref>.supabase.co/functions/v1/api`):

- **Google / Apple OAuth** redirect URIs →
  `…/v1/auth/google/callback` and `…/v1/auth/apple/callback`.
- **Stripe** webhook endpoint → `…/v1/webhooks/stripe`.

## Two differences from the Node server

- **No in-memory rate limiter.** Edge Functions are stateless, so the global
  per-IP token bucket from `server/src/ratelimit.js` is gone. The DB-backed
  per-device daily impression cap and per-device daily click cap (in
  `ingestBatch` / `redeemClickToken`) are unchanged and remain the real abuse
  controls.
- **Killswitch is per-isolate.** `serving` is derived from the `KILLSWITCH` env
  on each cold start; the `POST /v1/admin/killswitch` toggle only affects the
  isolate that handles it. Drive it from env (redeploy) if you need it global.

## Deploy

Via the Supabase MCP `deploy_edge_function`, or the CLI:

```
supabase functions deploy api --no-verify-jwt --project-ref <ref>
```
