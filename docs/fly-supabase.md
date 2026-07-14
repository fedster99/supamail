# Fly.io + Supabase Deployment

This is the recommended hosted setup for SupaMail.

Supabase hosts Postgres. Fly.io runs the sync worker as a small Docker Machine with no public IP. The API is optional and should be a separate Fly app when you need remote control endpoints.

## 1. Create Supabase Database

Use an existing Supabase project or create a new one. Copy the direct Postgres connection string when your runtime supports IPv6.

Supabase direct Postgres uses IPv6. If the runtime cannot reach IPv6, use the Supavisor session pooler on port `5432`. Do not use the transaction pooler on port `6543`.

Advisory locks are session-scoped. If Supabase pooler or PgBouncer is placed in transaction mode between the worker and Postgres, locks can silently lose their safety properties.

## 2. Deploy Worker

```bash
cp apps/api/fly.worker.toml.example apps/api/fly.worker.toml

fly launch --config apps/api/fly.worker.toml --no-deploy --no-db --no-public-ips --ha=false
fly secrets set --config apps/api/fly.worker.toml \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY"
fly deploy --config apps/api/fly.worker.toml --ha=false
```

The worker profile is intentionally small:

- `shared-cpu-1x`
- `256mb`
- no public IP
- conservative body and batch sizes

`--ha=false` keeps the starter worker to one Machine. Fly creates spare/standby Machines by default for availability, which is useful later but unnecessary for the cheapest first deploy.

## 3. Apply Schema

From the repository root, run migrations locally with the same `DATABASE_URL`:

```bash
DATABASE_URL="$DATABASE_URL" \
IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
pnpm migrate
```

Or, if you need to run SQL manually, apply the public migration files in manifest order:

```bash
for file in apps/api/supabase/migrations/public/*.sql; do
  psql "$DATABASE_URL" -f "$file"
done
```

## 4. Create Accounts

From the repository root, create accounts locally through the CLI:

```bash
DATABASE_URL="$DATABASE_URL" \
IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
pnpm --filter @supamail/api exec tsx src/cli.ts create-account \
  --email alice@example.com \
  --host imap.example.com \
  --port 993 \
  --username alice@example.com \
  --password "$IMAP_PASSWORD" \
  --profile generic-imap
```

The worker will pick up runnable accounts on its next tick.

## Optional API App

Only deploy the API if you need remote account creation, manual sync triggers, or body refetch endpoints.

```bash
cp apps/api/fly.api.toml.example apps/api/fly.api.toml

fly launch --config apps/api/fly.api.toml --no-deploy --no-db --ha=false
fly secrets set --config apps/api/fly.api.toml \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
  API_TOKEN="$API_TOKEN"
fly deploy --config apps/api/fly.api.toml --ha=false
```

The API refuses to start without `API_TOKEN`; only `/health` is public.

## Operational Checks

Useful tables:

- `imap_accounts.sync_state`
- `imap_accounts.backoff_until`
- `imap_sync_runs`
- `imap_sync_events`
- `imap_messages.body_fetched_at`
- `imap_message_bodies.raw_bytes`

Each `sync.tick.completed` worker log separates database write efficiency from
end-to-end throughput:

- `metadataWriteServiceRowsPerSecond` is committed metadata rows divided by cumulative persistence time.
- `metadataThroughputRowsPerSecond` is committed metadata rows divided by the full tick's monotonic wall time. Use this for production throughput.
- `metadataTelemetryComplete=false` makes both rates `null`, so mixed-version or incomplete results cannot report a misleading rate.

`metadataRowsCommitted` includes acknowledged conflict updates, not only newly discovered email. Per-run write counts, duration, batch attempts/failures, and write-service rate are also stored in `imap_sync_runs.metadata`.

Useful Fly commands:

```bash
fly status
fly logs
fly machines list
fly secrets list
```
