# imap-to-supabase

`imap-to-supabase` is a self-hosted IMAP mirror for Supabase/Postgres. It syncs mailbox folders, message metadata, flags, attachment metadata, sync health, and full RFC822/MIME message bodies into neutral Postgres tables.

The first target deployment is simple: Supabase hosts Postgres, Render runs the worker container, and an optional Render web service exposes the tiny control API.

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

## Render Setup

The included `render.yaml` defines:

- `imap-to-supabase-worker`: always-on Docker worker
- `imap-to-supabase-api`: optional Hono control API

Required environment variables:

```bash
DATABASE_URL=postgresql://...
IMAP_ENCRYPTION_KEY=...
API_TOKEN=...
BODY_FETCH_POLICY=priority_then_backfill
```

## CLI

```bash
pnpm install
pnpm migrate

pnpm exec imap-to-supabase create-account \
  --email alice@example.com \
  --host secure.emailsrvr.com \
  --port 993 \
  --username alice@example.com \
  --password "$IMAP_PASSWORD" \
  --profile rackspace

pnpm exec imap-to-supabase list-accounts
pnpm exec imap-to-supabase sync --account-id <uuid>
pnpm exec imap-to-supabase refetch-body --message-id <uuid>
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

## Source Extraction Notes

This repository is intentionally independent from Signal. It excludes CRM hydration, identity/belief code, MCP routes, Trigger.dev coupling, and internal dashboard logic.
