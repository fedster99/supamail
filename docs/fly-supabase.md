# Fly.io + Supabase Deployment

This is the recommended hosted setup for SupaMail.

Supabase hosts Postgres. Fly.io runs the sync worker as a small Docker Machine with no public IP. The API is optional and should be a separate Fly app when you need remote control endpoints.

## 1. Create Supabase Database

Use an existing Supabase project or create a new one. Copy the direct Postgres connection string. Do not use the transaction pooler URL.

Advisory locks are session-scoped. If Supabase pooler or PgBouncer is placed in transaction mode between the worker and Postgres, locks can silently lose their safety properties.

## 2. Deploy Worker

```bash
cp fly.worker.toml.example fly.toml

fly launch --no-deploy --no-public-ips --ha=false
fly secrets set \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY"
fly deploy --ha=false
```

The worker profile is intentionally small:

- `shared-cpu-1x`
- `256mb`
- no public IP
- conservative body and batch sizes

`--ha=false` keeps the starter worker to one Machine. Fly creates spare/standby Machines by default for availability, which is useful later but unnecessary for the cheapest first deploy.

## 3. Apply Schema

Run migrations locally with the same `DATABASE_URL`:

```bash
DATABASE_URL="$DATABASE_URL" \
IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
pnpm migrate
```

Or run the SQL directly:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_imap_mirror.sql
```

## 4. Create Accounts

Create accounts locally through the CLI:

```bash
DATABASE_URL="$DATABASE_URL" \
IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
pnpm exec supamail create-account \
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
cp fly.api.toml.example fly.api.toml

fly launch --config fly.api.toml --no-deploy --ha=false
fly secrets set --config fly.api.toml \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
  API_TOKEN="$API_TOKEN"
fly deploy --config fly.api.toml --ha=false
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

Useful Fly commands:

```bash
fly status
fly logs
fly machines list
fly secrets list
```
