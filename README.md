# SupaMail

[![CI](https://github.com/fedster99/supamail/actions/workflows/ci.yml/badge.svg)](https://github.com/fedster99/supamail/actions/workflows/ci.yml)

Reliable IMAP sync for Supabase.

SupaMail turns any IMAP inbox into queryable Supabase tables. It runs a worker/API, connects to your mailboxes, and keeps folders, messages, flags, full MIME bodies, attachment metadata, and sync health up to date in Postgres.

The simplest low-cost deployment is Supabase + Fly.io: Supabase hosts the database, Fly runs the always-on worker, and your app reads email from its own tables. The API is optional and can run as a separate Fly app when you need remote control endpoints.

## Background

I kept running into the same annoying problem at work.

Every new AI email tool integrates with Gmail. Some integrate with Outlook. But if your inbox is on any other email provider, you are usually out of luck. In my case, it was Rackspace.

And that makes sense. IMAP is old. It is messy. It has folders, weird cursors, UIDVALIDITY resets, flags, MIME bodies, provider quirks, silent failures, and a thousand tiny ways to miss an email.

But email is too valuable to leave locked behind whatever provider you happen to use.

So I built SupaMail.

It syncs any IMAP inbox into Supabase. Reliably. Full messages, folders, flags, bodies, attachments metadata, sync health, all of it.

The point is simple: once email is in Supabase, you can build whatever you want on top of it.

AI agents. Internal tools. CRM workflows. Search. Alerts. Automations.

SupaMail is the boring sync layer that makes the fun stuff possible.

## What You Get

- IMAP accounts and folder state
- Initial and incremental message sync
- UIDVALIDITY reset handling
- Reconciliation for provider deletes and missing messages
- Flags, headers, threading headers, and MIME structure
- Raw RFC822/MIME bodies
- Parsed text, HTML, normalized text, and parser metadata
- Attachment and inline-part metadata
- Sync runs, sync events, health, lag, retries, and backoff
- Folder-count safeguards for unusually large mailboxes
- Reactive rediscovery when a provider reports a mailbox no longer exists
- Provider profiles for generic IMAP and provider-specific quirks

## How It Works

```text
IMAP mailbox -> SupaMail worker/API -> Supabase/Postgres -> your app
```

SupaMail treats Postgres as the durable mailbox mirror. IMAP is the provider; Supabase is where your application reads from.

Account-level advisory locks keep sync operations serialized. Folder state tracks UID cursors and UIDVALIDITY. Reconciliation catches gaps so missing messages do not silently become permanent.

## Repository Layout

- `apps/api`: TypeScript/Node worker, API, CLI, tests, Supabase migration, Docker, and Fly configs.
- `apps/web`: Next.js landing site.
- `docs`: reliability contract, deployment notes, architecture decisions, and agent operating docs.
- `SESSION_HANDOFF.md`: tracked restart notes for future coding agents.

## Quickstart: Supabase + Fly.io

1. Create a Supabase project.
2. Use the direct/session-affine Postgres connection string for `DATABASE_URL`.
3. Deploy the worker from the repository root with `apps/api/fly.worker.toml.example`.
4. Set environment variables.
5. Run migrations.
6. Add an IMAP account.

Required environment variables:

```bash
DATABASE_URL=postgresql://...
IMAP_ENCRYPTION_KEY=...
API_TOKEN=...
BODY_FETCH_POLICY=priority_then_backfill
```

Apply the schema:

```bash
pnpm migrate
```

or, if you need to run SQL manually, apply the public migration files in manifest order:

```bash
for file in apps/api/supabase/migrations/public/*.sql; do
  psql "$DATABASE_URL" -f "$file"
done
```

Important: use a direct Supabase Postgres URL or the Supavisor session pooler on port `5432`. Do not use the transaction pooler on port `6543`. SupaMail uses advisory locks, and advisory locks need session affinity.

See [docs/fly-supabase.md](docs/fly-supabase.md) for the full Fly.io + Supabase setup.

See [docs/hosted-product-boundary.md](docs/hosted-product-boundary.md) for what belongs outside the open-source core.

See [docs/hosted-cloud-contracts.md](docs/hosted-cloud-contracts.md) for the public contracts that the private hosted SaaS layer must consume.

See [docs/imap-auth-v1.md](docs/imap-auth-v1.md) for the v1 IMAP authentication scope.

See [docs/spec-conformance.md](docs/spec-conformance.md) for the public reliability matrix against the old Signal sync-engine spec that SupaMail was extracted from.

## Add a Mailbox

```bash
pnpm install
pnpm migrate

pnpm --filter @supamail/api exec tsx src/cli.ts create-account \
  --email alice@example.com \
  --host imap.example.com \
  --port 993 \
  --username alice@example.com \
  --password "$IMAP_PASSWORD" \
  --profile generic-imap
```

Then start the worker:

```bash
pnpm build
pnpm --filter @supamail/api start:worker
```

Or run the API:

```bash
pnpm --filter @supamail/api start:api
```

The Docker/runtime entrypoint also supports `SUPAMAIL_MODE=worker|api|combined`. `combined` runs the API and worker in one Node process for small deployments.

## Query Your Email

Recent messages:

```sql
select
  m.id,
  m.internal_date,
  m.from_email,
  m.subject,
  m.flags,
  m.body_fetched_at
from imap_messages m
where m.deleted_in_provider = false
order by m.internal_date desc
limit 50;
```

Full body:

```sql
select
  m.subject,
  b.body_text,
  b.body_html,
  b.raw_bytes,
  b.fetched_at
from imap_messages m
join imap_message_bodies b on b.message_id = m.id
where m.id = '<message-id>';
```

Sync health:

```sql
select
  email_address,
  sync_state,
  sync_state_reason,
  priority_sync_lag_seconds,
  overall_sync_lag_seconds,
  last_sync_finished_at
from imap_accounts;
```

## Body Sync

`BODY_FETCH_POLICY` controls when full bodies are fetched:

- `immediate`: fetch body rows for every in-window message during sync.
- `lazy`: fetch bodies only when `refetch-body` or the API endpoint is called.
- `priority_then_backfill`: fetch bodies for priority folders such as INBOX and Sent during normal sync. This is the default.

SupaMail stores raw RFC822/MIME bytes plus parsed text, HTML, headers, MIME structure, selected text part, and parser warnings.

Attachment binaries are not downloaded by default. SupaMail stores attachment metadata, MIME part numbers, content IDs, and optional future storage keys.

## API

`API_TOKEN` is required to run the API service. Every endpoint except `/health` requires `Authorization: Bearer $API_TOKEN`.

- `GET /health`
- `POST /migrate`
- `GET /accounts`
- `POST /accounts`
- `POST /accounts/:id/sync`
- `POST /messages/:id/refetch-body`

Account responses intentionally omit encrypted passwords, lock IDs, and worker internals.

Example:

```bash
curl -X POST "$API_URL/accounts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddress": "alice@example.com",
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "username": "alice@example.com",
    "password": "secret",
    "providerProfile": "generic-imap",
    "bodyFetchPolicy": "priority_then_backfill"
  }'
```

## Library Hooks

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

## Deployment Options

- `apps/api/fly.worker.toml.example`: low-cost Fly.io worker-only deployment
- `apps/api/fly.api.toml.example`: optional Fly.io API deployment
- `apps/api/compose.yaml`: Docker Compose / Coolify / VPS deployment

See [docs/deployment-options.md](docs/deployment-options.md) for tradeoffs.

## Local Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:db:live
pnpm build
```

Live DB reliability tests:

```bash
pnpm test:db:live
```

This starts a disposable `postgres:16-alpine` container on a random localhost port, applies the migration twice, runs the DB-backed sync engine suites, runs spec conformance, and removes the container. Set `KEEP_DB=1` to leave the container running for inspection.

Local Supabase dry run:

```bash
supabase db start --workdir apps/api/supabase

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm migrate

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm --filter @supamail/api dry-run:local
```

Protocol smoke test:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm --filter @supamail/api smoke:greenmail
```

Load smoke test:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
NODE_OPTIONS=--max-old-space-size=160 \
pnpm --filter @supamail/api smoke:load
```

`pnpm --filter @supamail/api dry-run:local` uses a fake IMAP client with fixture folders, messages, MIME bodies, and attachment metadata. `pnpm --filter @supamail/api smoke:greenmail` starts a disposable `greenmail/standalone` Docker IMAP/SMTP server and syncs through the real IMAP protocol.

## Project Status

SupaMail is early and intentionally focused: email sync only. No calendar, contacts, sending, scheduling, CRM, identity hydration, or AI features are included in the core.

The repo is independent from the app it came from. It excludes CRM hydration, person/company identity resolution, handle mapping, identity/belief code, MCP routes, Trigger.dev coupling, and internal dashboard logic.
