# Render + Supabase Deployment

## 1. Create Supabase Database

Use an existing Supabase project or create a new one. Copy the direct Postgres connection string. Do not use the transaction pooler URL.

## 2. Configure Secrets

Set these Render environment variables on both services:

- `DATABASE_URL`
- `IMAP_ENCRYPTION_KEY`

Set `API_TOKEN` on the API service if it is exposed outside a private network.

## 3. Apply Schema

Run the API migration endpoint once:

```bash
curl -X POST "$API_URL/migrate" \
  -H "Authorization: Bearer $API_TOKEN"
```

or run the CLI locally with the same `DATABASE_URL`.

## 4. Create Accounts

```bash
curl -X POST "$API_URL/accounts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddress": "alice@example.com",
    "host": "secure.emailsrvr.com",
    "port": 993,
    "secure": true,
    "username": "alice@example.com",
    "password": "secret",
    "providerProfile": "rackspace",
    "bodyFetchPolicy": "priority_then_backfill"
  }'
```

## 5. Run Worker

The worker loops on `SYNC_INTERVAL_MS`, claims eligible accounts with advisory locks, and records every run in `imap_sync_runs`.

## Operational Checks

- `imap_accounts.sync_state`
- `imap_accounts.backoff_until`
- `imap_sync_runs`
- `imap_sync_events`
- `imap_messages.body_fetched_at`
- `imap_message_bodies.raw_bytes`

## Connection Warning

Advisory locks are session-scoped. If Supabase pooler or PgBouncer is placed in transaction mode between the worker and Postgres, locks can silently lose their safety properties. Use direct Postgres or session pooling.
