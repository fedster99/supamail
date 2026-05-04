# Supamail

Supamail is a self-hosted IMAP mirror for Supabase/Postgres. It syncs mailbox folders, message metadata, flags, attachment metadata, sync health, and full RFC822/MIME message bodies into neutral Postgres tables.

The first target deployment is simple: Supabase hosts Postgres, a container host runs the worker, and an optional web service exposes the tiny control API.

## What It Syncs

- IMAP accounts and folder state
- Initial and incremental message metadata
- UIDVALIDITY resets and soft-deletes
- Reconciliation for messages no longer visible in a folder
- Flags and MIME structure from IMAP metadata fetches
- Attachment and inline-part metadata from BODYSTRUCTURE
- Full raw RFC822/MIME body bytes
- Parsed `text/plain`, `text/html`, normalized body text, headers, and parser metadata
- Sync runs and append-only sync events

## Body Fetch Policy

`BODY_FETCH_POLICY` controls when bodies are fetched:

- `immediate`: fetch body rows for every in-window message during sync.
- `lazy`: only fetch bodies when `refetch-body` or the API endpoint is called.
- `priority_then_backfill`: fetch bodies for priority folders such as INBOX and Sent during normal sync. This is the default.

Attachment binaries are not downloaded by default. The mirror stores attachment metadata, MIME part numbers, content IDs, and optional future storage keys.

## Supabase Setup

Apply the migration:

```bash
pnpm migrate
```

or run:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_imap_mirror.sql
```

Use a direct/session-affine Supabase Postgres URL for `DATABASE_URL`. Transaction pooler URLs are rejected because account-level advisory locks require session affinity.

## Deployment

Supported deployment files:

- `render.yaml`: Render worker and optional API
- `fly.worker.toml.example`: low-cost Fly.io worker-only deployment
- `fly.api.toml.example`: optional Fly.io API deployment
- `compose.yaml`: Docker Compose / Coolify / VPS deployment

Required environment variables:

```bash
DATABASE_URL=postgresql://...
IMAP_ENCRYPTION_KEY=...
API_TOKEN=...
BODY_FETCH_POLICY=priority_then_backfill
```

See [docs/deployment-options.md](docs/deployment-options.md) for the cost/ops tradeoffs.

## CLI

```bash
pnpm install
pnpm migrate

pnpm exec supamail create-account \
  --email alice@example.com \
  --host secure.emailsrvr.com \
  --port 993 \
  --username alice@example.com \
  --password "$IMAP_PASSWORD" \
  --profile rackspace

pnpm exec supamail list-accounts
pnpm exec supamail sync --account-id <uuid>
pnpm exec supamail refetch-body --message-id <uuid>
```

## API

All endpoints require `Authorization: Bearer $API_TOKEN` when `API_TOKEN` is set.

- `GET /health`
- `POST /migrate`
- `GET /accounts`
- `POST /accounts`
- `POST /accounts/:id/sync`
- `POST /messages/:id/refetch-body`

## Hook Surface

Library users can instantiate `MirrorEngine` with hooks:

```ts
new MirrorEngine({
  hooks: {
    onMessageUpsert: async (message) => {},
    onBodyFetched: async (message, body) => {},
    onMessageDeleted: async (message) => {},
    onFolderChanged: async (folder) => {},
    onSyncRunCompleted: async (result) => {}
  }
});
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Local Supabase Dry Run

The repo includes a local Supabase config on alternate ports so it can run beside the Signal dev stack.

```bash
supabase db start
supabase db reset --local

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm dry-run:local
```

`pnpm dry-run:local` uses a fake IMAP client with fixture folders, messages, MIME bodies, and attachment metadata. It applies the migration, runs the real `MirrorEngine` twice, asserts the mirrored rows, then deletes the fixture account unless `SUPAMAIL_DRY_RUN_KEEP_DATA=true` is set.

## Source Extraction Notes

This repository is intentionally independent from Signal. It excludes CRM hydration, identity/belief code, MCP routes, Trigger.dev coupling, and internal dashboard logic.
