# Hosted Cloud Contracts

This public repo is the reusable SupaMail core. The private hosted SaaS repo consumes these contracts but owns signup, billing, Supabase OAuth, tenant provisioning, remote MCP auth, and hosted support operations.

## Runtime And Image Contract

- Node is pinned to 24.x across package engines, CI, Docker, Fly examples, and the web app runtime.
- The public core image is published to GHCR from `main` only after CI succeeds.
- Hosted cloud must pin the public image by digest or git-SHA tag, not `latest`.
- `SUPAMAIL_MODE=worker|api|combined` selects the runtime process. `combined` is the stage-one shape for the private Fly app.

## Public Migrations

- Customer databases receive only `apps/api/supabase/migrations/public/*`.
- `manifest.json` records the ordered public migration ids and required public schema version.
- `pnpm migrate`, the CLI, and API `/migrate` apply public migrations only.
- Private hosted control-plane migrations belong only in `supamail-cloud`.
- A hosted deploy must run a migration gate for every active database target before running a new pinned core image against that target.

If a target cannot migrate, hosted cloud should mark it `needs_attention` or paused and skip sync/API/MCP for that target until migration succeeds. One failed BYO target must not block other targets.

## Multi-Target Scheduler

The public `target-scheduler` contract is intentionally database-agnostic so hosted cloud can schedule BYO targets around the same core engine.

- Global concurrency caps total active target work in one process.
- Per-target concurrency defaults to `1`.
- Paused and `needs_attention` targets are skipped.
- Targets with stale public schema versions are skipped.
- Target failures are returned as rejected results and must not stop other runnable targets.
- Scheduler shutdown aborts skip work that has not started yet and pass the abort signal to in-flight work.

## Hosted Secrets

Supabase OAuth refresh tokens, generated Supabase DB passwords, IMAP credentials, API tokens, and MCP tokens must be encrypted before storage. Encryption keys live in Fly/Vercel secrets only. Plaintext secrets must not be stored in the control-plane database, logs, PRs, or tracked env examples.

## Billing Boundary

The public v1 paid product is `$5/month Hosted BYO Supabase`: subscription billing, 7-day no-card trial, and Stripe customer portal. Managed is private beta/manual approval.

Stripe webhook handling belongs in the private Vercel app and must use a Node runtime route. The route verifies the raw-body signature, stores the event, inserts a fulfillment job, and returns `200` quickly. The `stripe_events.stripe_event_id` column must be unique so duplicate deliveries cannot run fulfillment twice.

## Build Order

1. Public `supamail` GHCR image pipeline.
2. Private `supamail-cloud` Vercel app with Supabase Auth, Stripe Checkout, customer portal, webhook ingest, and fulfillment queue.
3. Private Fly runtime extending the pinned public image.
4. Supabase OAuth BYO onboarding.
5. End-to-end paid smoke with the maintainer as the first customer.
